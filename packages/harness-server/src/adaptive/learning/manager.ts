/**
 * The learning manager: episode → reflection → proposal → promotion (FH-034).
 *
 * It hangs off the coordinator's terminal callback and a sweep, exactly like the shadow, and it is
 * asynchronous and inert to failure by construction: a session is never blocked and never fails, so
 * a reflection that goes wrong is recorded and dropped. The durable guarantee is the `reflection_job`
 * primary key (`episode_id`): a pass first claims the episode by inserting a `pending` row, and only
 * the pass that claimed it reflects, so a second close, a restart or a second harness process on the
 * same database cannot spend twice. Once the job is terminal — done, skipped or failed — it is never
 * reflected again; a `pending` claim older than `REFLECTION_LEASE_MS` is a process that died
 * mid-reflection, and the sweep takes it over rather than leaving the episode stuck.
 *
 * Nothing here writes a skill: the manager lints the draft against the roster and stages it as a
 * `proposed` row. The draft is built from evidence that can carry untrusted tool output, so it only
 * reaches `skills/` when a person approves it through the review route, which asks the curator — the
 * single write path (ADR-0019 §2) — to install it (AH-A04). The classification and the draft are gated by the learning switch, the
 * egress allowlist and a resolved model, and every skip is a machine-readable reason on the job. When
 * the model path cannot run, the heuristic classifier (AH-F01, `heuristics.ts`) is the local fallback:
 * its template proposal goes through the same redaction, lint and staging. A kill switch stops the
 * reflection and the curation; it never deletes a skill already written. The freeze and the
 * per-project caps (AH-F03, `./limits`) are gates too: `frozen` or `limit:<name>`.
 */

import type { AdaptiveConfig } from "../config"
import type { DecisionKind, DecisionRequest, DecisionResult } from "../decision"
import type { EgressGuard, EgressSubject } from "../egress"
import type { SkillCurator } from "../skills/curator"
import type { SkillDraft, SkillDrafter } from "./draft"
import { DRAFT_LIMITS, learningModel } from "./draft"
import type { SkillProposal } from "./proposal"
import { proposalID } from "./proposal-record"
import type { StoredSkillProposalInput } from "./proposal-record"
import { contentHashOf } from "../skills/learned-store"
import { LEARNING_FROZEN_REASON, blockingLimit, limitReason, reachedLimits } from "./limits"
import { HEURISTIC_LIMITS, classifyEpisode, heuristicModelVersion } from "./heuristics"
import type { TraceStep } from "./heuristics"
import {
  DEFAULT_REFLECTION_SWEEP_LIMIT,
  REFLECTION_LEASE_MS,
  reflectionCandidates,
  reflectionClaimable,
  reflectionGate,
  reflectionSignals,
} from "./reflection-job"
import type { EpisodeRepository, LearningRepository, ReflectionRepository, SessionEpisode } from "../../types"

/** The read side the manager needs: jobs, proposals, evidence and the episodes a sweep walks. */
export type LearningManagerRepository = LearningRepository &
  ReflectionRepository &
  Pick<EpisodeRepository, "listEpisodes">

/** The slice of `DecisionService` the reflection uses; a fake satisfies it in tests. */
export type ReflectionService = {
  predict<Q extends DecisionKind>(request: DecisionRequest<Q>, mode?: "hot" | "batch"): Promise<DecisionResult<Q>>
}

export type LearningManagerDeps = {
  repository: LearningManagerRepository
  service: ReflectionService
  config: () => AdaptiveConfig
  egress: Pick<EgressGuard, "allows" | "redact">
  /**
   * The registered models, for the locality of the one `skillReflection` is assigned to. An assigned
   * id not listed here is treated as remote, so it needs its provider's consent.
   */
  models?: readonly EgressSubject[]
  curator: Pick<SkillCurator, "roster" | "check" | "readExisting" | "recompute" | "reconcile">
  drafter: SkillDrafter
  /** The global `small_model`; absent leaves `adaptive.learning.model` as the only source. */
  smallModel?: () => string | undefined
  /**
   * The ordered tool trace of an episode, for the heuristic classifier (AH-F01). The server reads the
   * plugin's signal files (`episodeTrace`); absent, the `fix-verify` pattern has nothing to read.
   */
  trace?: (episode: SessionEpisode) => readonly TraceStep[]
  onError?: (cause: unknown) => void
  now?: () => number
  sweepLimit?: number
}

export type LearningRunner = {
  /** Fire-and-forget: it returns nothing and never throws toward the coordinator. */
  onEpisodeClosed(episode: SessionEpisode): void
  /** Restart backstop: terminal episodes with no job yet. */
  sweep(): number
  start(): void
  stop(): void
}

/** Why a reflection failed outright; the row carries the code, the cause goes to `onError`. */
export const REFLECTION_FAILED_REASON = "orchestration-failed"

export function createLearningManager(deps: LearningManagerDeps): LearningRunner {
  const onError = deps.onError ?? (() => {})
  const now = deps.now ?? Date.now
  const sweepLimit = deps.sweepLimit ?? DEFAULT_REFLECTION_SWEEP_LIMIT
  const trace = deps.trace ?? (() => [])
  // The durable claim covers other processes; this also keeps a pass of this process that outlives
  // its own lease from being taken over by this process's next sweep.
  const inFlight = new Set<string>()

  const jobFor = (
    episode: SessionEpisode,
    status: "pending" | "skipped" | "done" | "failed",
    extra: { reason?: string; decisionID?: string; proposalID?: string } = {},
  ): void => {
    deps.repository.createReflectionJob(
      {
        episodeID: episode.id,
        sessionID: episode.sessionID,
        projectID: episode.projectID,
        status,
        attempts: 1,
        ...extra,
      },
      now(),
    )
  }

  /** The bounded state a reflection decision reads: objective, signals and the current roster. */
  const reflectionState = (episode: SessionEpisode, roster: ReturnType<SkillCurator["roster"]>) => ({
    episodeID: episode.id,
    objective: episode.objective,
    outcome: episode.outcome,
    toolCalls: episode.toolCalls,
    signals: reflectionSignals(episode),
    skills: roster.map(({ name, description, learned }) => ({ name, description, learned })),
  })

  /** The proposal fields shared by the write before and after the curator decides. */
  const proposalInput = (input: {
    episode: SessionEpisode
    decisionID: string
    proposal: SkillProposal
    modelVersion: string
  }): StoredSkillProposalInput => {
    const { episode, proposal } = input
    const body = proposal.body
    return {
      id: proposalID(episode.id),
      episodeID: episode.id,
      sessionID: episode.sessionID,
      projectID: proposal.projectID,
      decisionID: input.decisionID,
      intent: proposal.intent,
      ...(proposal.targetSkill ? { targetSkill: proposal.targetSkill } : {}),
      name: proposal.name,
      description: proposal.description,
      body,
      bodyHash: contentHashOf(body),
      evidenceRefs: proposal.evidenceRefs,
      ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
      modelVersion: input.modelVersion,
      status: "proposed",
    }
  }

  /** One episode, end to end. Every early exit is a job reason; nothing here is raised to a caller. */
  const orchestrate = async (episode: SessionEpisode, config: AdaptiveConfig): Promise<void> => {
    const gate = reflectionGate(episode, config.learning)
    if (!gate.reflect) {
      jobFor(episode, "skipped", { reason: gate.reason })
      return
    }
    // Frozen (AH-F03) stops what is new and nothing else: staged proposals stay reviewable and
    // installed skills keep loading. An episode closed while frozen is not reflected later either, so
    // unfreezing never releases a backlog at once.
    if (config.learning.frozen) {
      jobFor(episode, "skipped", { reason: LEARNING_FROZEN_REASON })
      return
    }

    // The classification is the door: without a model the guard lets out for this project, no question
    // is asked, so a reflection that could not be classified is skipped rather than answered inertly
    // and mislabelled. The consent checked is the assigned model's own provider's (AH-C03). The draft
    // below goes to the small model through the engine; its consent is `learning.enabled` itself.
    const assigned = config.models.skillReflection
    const classifier =
      assigned === undefined
        ? undefined
        : (deps.models?.find((model) => model.id === assigned) ?? { id: assigned, locality: "remote" as const })
    if (!classifier || !deps.egress.allows(classifier, "skillReflection", episode.projectID)) {
      heuristic(episode, config, { reason: "egress-denied" })
      return
    }

    // One roster read for the whole reflection: the classification's own view and the curator's
    // validation at write time. The store still checks collision live, so this only saves the scan.
    const roster = deps.curator.roster(episode.projectID)
    // The caps (AH-F03) before any spend: a project whose every outcome is capped is not classified.
    const limitHits = () =>
      reachedLimits({
        repository: deps.repository,
        projectID: episode.projectID,
        installedSkills: roster.filter((entry) => entry.learned).length,
        limits: config.learning.limits,
        now: now(),
      })
    const capped = blockingLimit(limitHits())
    if (capped) {
      jobFor(episode, "skipped", { reason: limitReason(capped) })
      return
    }
    const request: DecisionRequest<"skillReflection"> = {
      kind: "skillReflection",
      episodeID: episode.id,
      sessionID: episode.sessionID,
      projectID: episode.projectID,
      policy: config.decisions.skillReflection,
      state: reflectionState(episode, roster),
    }
    const result = await deps.service.predict(request, "batch")
    const decisionID = `skillReflection:${episode.id}`
    const answer = result.answer

    if (!answer.reusable) {
      jobFor(episode, "skipped", { reason: "not-reusable", decisionID })
      return
    }
    // `merge`/`drop` are declared but deferred (FH-044); the refusal is explicit, never silent.
    if (answer.intent === "merge" || answer.intent === "drop") {
      jobFor(episode, "skipped", { reason: `unsupported-intent:${answer.intent}`, decisionID })
      return
    }
    if (answer.intent === "patch" && !answer.target) {
      jobFor(episode, "skipped", { reason: "missing-target", decisionID })
      return
    }

    // The intent's own cap before the draft: a full project may still patch, and patches may be capped.
    const cappedByIntent = blockingLimit(limitHits(), answer.intent)
    if (cappedByIntent) {
      jobFor(episode, "skipped", { reason: limitReason(cappedByIntent), decisionID })
      return
    }

    const model = learningModel(config.learning, deps.smallModel)
    if (!model) {
      heuristic(episode, config, { reason: "no-model", decisionID }, roster)
      return
    }

    const evidence = deps.repository.evidenceFor(episode).map((slice) => slice.content)
    // A patch improves the skill it names; reading the current body first makes the draft a revision
    // rather than a blind overwrite, and the re-read counts as a `view` (ADR-0019 §5).
    const existing =
      answer.intent === "patch" && answer.target
        ? deps.curator.readExisting(episode.projectID, answer.target)
        : undefined
    const draft = await deps.drafter.draft({
      directory: episode.projectID,
      objective: episode.objective,
      signals: reflectionSignals(episode),
      evidence,
      ...(existing
        ? {
            existing: {
              name: existing.name,
              description: bound(existing.description, DRAFT_LIMITS.maxDescriptionChars),
              body: bound(existing.body, config.learning.maxBodyChars),
            },
          }
        : {}),
    })
    if (!draft) {
      heuristic(episode, config, { reason: "draft-failed", decisionID }, roster)
      return
    }
    // Counted again after the last `await`: reflections that ran side by side cannot overshoot a cap
    // together, since nothing below yields before the proposal is written.
    const cappedAfterDraft = blockingLimit(limitHits(), answer.intent)
    if (cappedAfterDraft) {
      jobFor(episode, "skipped", { reason: limitReason(cappedAfterDraft), decisionID })
      return
    }

    stage({
      episode,
      config,
      roster,
      draft,
      decisionID,
      intent: answer.intent,
      ...(answer.intent === "patch" && answer.target ? { targetSkill: answer.target } : {}),
      evidenceRefs: episode.evidenceRefs,
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      modelVersion: `${model.providerID}/${model.id}`,
      evidence,
    })
  }

  /**
   * The model-free path (AH-F01): the model path could not run — no classifier with consent, no
   * drafting model, or a failed draft — so the heuristic classifier gets its turn. It runs locally
   * with no egress, and its candidate is staged exactly like a draft: redacted, linted, `proposed`.
   * No candidate keeps the model path's own skip reason, so a quiet episode reads as it did before.
   * An explicit `not-reusable` answer never reaches here: a classifier that spoke is not overridden.
   */
  const heuristic = (
    episode: SessionEpisode,
    config: AdaptiveConfig,
    skipped: { reason: string; decisionID?: string },
    roster?: ReturnType<SkillCurator["roster"]>,
  ): void => {
    const candidate = classifyEpisode({
      episode,
      trace: trace(episode),
      history: deps.repository.listEpisodes({ projectID: episode.projectID, limit: HEURISTIC_LIMITS.historyEpisodes }),
    })
    if (!candidate) {
      jobFor(episode, "skipped", skipped)
      return
    }
    // One lesson, one proposal: a pattern that recurs is not staged again while its first proposal
    // waits, and a person who rejected it is not asked a second time.
    const seen = deps.repository
      .listProposals({ projectID: episode.projectID })
      .some((proposal) => proposal.name === candidate.name || proposal.targetSkill === candidate.name)
    if (seen) {
      jobFor(episode, "skipped", { reason: "heuristic-duplicate" })
      return
    }
    // The caps (AH-F03) hold for this path too: a heuristic proposal is always a new skill.
    const skills = roster ?? deps.curator.roster(episode.projectID)
    const capped = blockingLimit(
      reachedLimits({
        repository: deps.repository,
        projectID: episode.projectID,
        installedSkills: skills.filter((entry) => entry.learned).length,
        limits: config.learning.limits,
        now: now(),
      }),
      "add",
    )
    if (capped) {
      jobFor(episode, "skipped", { reason: limitReason(capped) })
      return
    }
    stage({
      episode,
      config,
      roster: skills,
      draft: candidate,
      decisionID: `heuristic:${episode.id}`,
      intent: "add",
      evidenceRefs: [...episode.evidenceRefs, ...candidate.supportingEpisodes].slice(0, 20),
      confidence: candidate.confidence,
      modelVersion: heuristicModelVersion(candidate.pattern),
      evidence: deps.repository.evidenceFor(episode).map((slice) => slice.content),
    })
  }

  /** Redact, bound, lint and store one proposal, drafted or heuristic; nothing here installs it. */
  const stage = (input: {
    episode: SessionEpisode
    config: AdaptiveConfig
    roster: ReturnType<SkillCurator["roster"]>
    draft: SkillDraft
    decisionID: string
    intent: SkillProposal["intent"]
    targetSkill?: string
    evidenceRefs: string[]
    confidence?: number
    modelVersion: string
    /** The episode's evidence text, read only by the URL filter (AH-F04) and never stored. */
    evidence: readonly string[]
  }): void => {
    // Redact and bound every text the row stores: none may keep what egress would not let out.
    const body = bound(redactedText(deps.egress, input.draft.body), input.config.learning.maxBodyChars)
    const proposal: SkillProposal = {
      projectID: input.episode.projectID,
      episodeID: input.episode.id,
      decisionID: input.decisionID,
      intent: input.intent,
      ...(input.targetSkill ? { targetSkill: input.targetSkill } : {}),
      name: bound(redactedText(deps.egress, input.draft.name), DRAFT_LIMITS.maxNameChars),
      description: bound(redactedText(deps.egress, input.draft.description), DRAFT_LIMITS.maxDescriptionChars),
      body,
      evidenceRefs: input.evidenceRefs.length > 0 ? input.evidenceRefs : [input.episode.id],
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      modelVersion: input.modelVersion,
      evidence: input.evidence,
    }
    const stored = proposalInput({ episode: input.episode, decisionID: input.decisionID, proposal, modelVersion: input.modelVersion })
    // The secret lint reads the draft as the model wrote it: the proposal above is already redacted,
    // so linting it would never find the secret and would stage a quietly edited skill instead of
    // refusing it. The row still keeps only the redacted text.
    const leaked = [input.draft.name, input.draft.description, input.draft.body].some((text) => redactedText(deps.egress, text) !== text)
    // Staged, never installed: a lint failure stays reviewable with its reason, and a clean draft waits
    // as `proposed` for a person. The approval re-runs the lint against the roster of that moment.
    const checked = leaked
      ? { ok: false as const, reason: "contains-secrets" as const }
      : deps.curator.check(proposal, input.roster)
    if (!checked.ok) {
      deps.repository.createProposal({ ...stored, status: "rejected", reason: checked.reason }, now())
      jobFor(input.episode, "skipped", { reason: checked.reason, decisionID: input.decisionID, proposalID: stored.id })
      return
    }
    deps.repository.createProposal(stored, now())
    jobFor(input.episode, "done", { reason: "proposed", decisionID: input.decisionID, proposalID: stored.id })
  }

  /** The deferred pass: the gate, the idempotence and the failure record all live here. */
  const reflect = async (episode: SessionEpisode): Promise<void> => {
    const config = deps.config()
    if (!config.enabled || !config.learning.enabled) return
    if (episode.endedAt === undefined) return
    if (inFlight.has(episode.id)) return
    // Claimed before any model call: a terminal job or another live claim means someone else reflects.
    const claimed = deps.repository.claimReflectionJob(
      { episodeID: episode.id, sessionID: episode.sessionID, projectID: episode.projectID },
      now(),
      REFLECTION_LEASE_MS,
    )
    if (!claimed) return
    inFlight.add(episode.id)
    try {
      await orchestrate(episode, config)
    } catch (cause) {
      try {
        jobFor(episode, "failed", { reason: REFLECTION_FAILED_REASON })
      } catch {
        // A failure to record the failure is still not a reason to reach the coordinator.
      }
      onError(cause)
    } finally {
      inFlight.delete(episode.id)
    }
  }

  const onEpisodeClosed = (episode: SessionEpisode): void => {
    // Enqueue only. Reading the roster is filesystem I/O and calling a model can take long; neither
    // belongs on the coordinator's close path.
    void Promise.resolve()
      .then(() => reflect(episode))
      .catch(onError)
  }

  const sweep = (): number => {
    const config = deps.config()
    if (!config.enabled) return 0
    try {
      const episodes = deps.repository.listEpisodes({ limit: sweepLimit })
      const projects = new Set(episodes.map((episode) => episode.projectID))
      if (config.learning.enabled) {
        // The lifecycle (FH-042, AH-F02) looks at every project the sweep saw: `recompute` reconciles
        // reverse collisions first, then lists the skills to suggest archiving. It never moves or
        // re-labels a skill, so a later sweep is a no-op and nothing is re-enqueued.
        for (const projectID of projects) if (projectID) deps.curator.recompute(projectID)
      } else {
        // A human-name collision is repaired on disk as a security move even with learning off: the
        // learned skill leaves `skills/`, so the engine's scanner cannot load it over the human
        // (ADR-0022 §4). It runs before the learning gate because it is a move, not a learning write.
        for (const projectID of projects) if (projectID) deps.curator.reconcile(projectID)
      }
      if (!config.learning.enabled) return 0
      return reflectionCandidates({
        episodes,
        hasJob: (episodeID) =>
          !reflectionClaimable(deps.repository.getReflectionJob(episodeID), now(), REFLECTION_LEASE_MS),
        limit: sweepLimit,
      }).reduce((count, episode) => {
        onEpisodeClosed(episode)
        return count + 1
      }, 0)
    } catch (cause) {
      onError(cause)
      return 0
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    if (timer) return
    sweep()
    timer = setInterval(() => {
      sweep()
    }, deps.config().episode.sweepMs)
    timer.unref()
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return { onEpisodeClosed, sweep, start, stop }
}

/** The redactor applied to the one long text a proposal stores; non-string output is left alone. */
function redactedText(egress: Pick<EgressGuard, "redact">, text: string): string {
  const value = egress.redact(text)
  return typeof value === "string" ? value : text
}

/** A text past its cap is cut, not stored whole; the draft lint already refused the rest. */
function bound(text: string, maxChars: number): string {
  return text.slice(0, maxChars)
}
