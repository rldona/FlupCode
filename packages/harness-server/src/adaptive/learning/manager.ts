/**
 * The learning manager: episode → reflection → proposal → promotion (FH-034).
 *
 * It hangs off the coordinator's terminal callback and a sweep, exactly like the shadow, and it is
 * asynchronous and inert to failure by construction: a session is never blocked and never fails, so
 * a reflection that goes wrong is recorded and dropped. The durable guarantee is the `reflection_job`
 * primary key (`episode_id`): once an episode has a job — done, skipped or failed — it is never
 * reflected again, so a second close or a restart cannot spend twice. An in-process set closes the
 * gap while the first pass is still running, which is the only window the row does not cover yet.
 *
 * Nothing here writes a skill: the manager validates and asks the curator, which owns the single
 * write path (ADR-0019 §2). The classification and the draft are gated by the learning switch, the
 * egress allowlist and a resolved model, and every skip is a machine-readable reason on the job. A
 * kill switch stops the reflection and the curation; it never deletes a skill already written.
 */

import type { AdaptiveConfig } from "../config"
import type { DecisionKind, DecisionRequest, DecisionResult } from "../decision"
import type { EgressGuard } from "../egress"
import type { SkillCurator } from "../skills/curator"
import type { SkillDrafter } from "./draft"
import { DRAFT_LIMITS, learningModel } from "./draft"
import type { SkillProposal } from "./proposal"
import { proposalID } from "./proposal-record"
import type { StoredSkillProposalInput } from "./proposal-record"
import { contentHashOf } from "../skills/learned-store"
import {
  DEFAULT_REFLECTION_SWEEP_LIMIT,
  reflectionCandidates,
  reflectionGate,
  reflectionSignals,
} from "./reflection-job"
import type {
  EpisodeRepository,
  LearningRepository,
  ReflectionRepository,
  SessionEpisode,
} from "../../types"

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
  curator: Pick<SkillCurator, "roster" | "promote" | "readExisting" | "recompute" | "reconcile">
  drafter: SkillDrafter
  /** The global `small_model`; absent leaves `adaptive.learning.model` as the only source. */
  smallModel?: () => string | undefined
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

    // The classification is the door: without egress no question leaves, so a reflection that could
    // not be classified is skipped rather than answered inertly and mislabelled.
    if (!deps.egress.allows("skillReflection", episode.projectID)) {
      jobFor(episode, "skipped", { reason: "egress-denied" })
      return
    }

    // One roster read for the whole reflection: the classification's own view and the curator's
    // validation at write time. The store still checks collision live, so this only saves the scan.
    const roster = deps.curator.roster(episode.projectID)
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

    const model = learningModel(config.learning, deps.smallModel)
    if (!model) {
      jobFor(episode, "skipped", { reason: "no-model", decisionID })
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
      jobFor(episode, "skipped", { reason: "draft-failed", decisionID })
      return
    }

    // Redact and bound every text the row stores: none may keep what egress would not let out.
    const body = bound(redactedText(deps.egress, draft.body), config.learning.maxBodyChars)
    const proposal: SkillProposal = {
      projectID: episode.projectID,
      episodeID: episode.id,
      decisionID,
      intent: answer.intent,
      ...(answer.intent === "patch" && answer.target ? { targetSkill: answer.target } : {}),
      name: bound(redactedText(deps.egress, draft.name), DRAFT_LIMITS.maxNameChars),
      description: bound(redactedText(deps.egress, draft.description), DRAFT_LIMITS.maxDescriptionChars),
      body,
      evidenceRefs: episode.evidenceRefs.length > 0 ? episode.evidenceRefs : [episode.id],
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      modelVersion: `${model.providerID}/${model.id}`,
    }
    const input = proposalInput({
      episode,
      decisionID,
      proposal,
      modelVersion: `${model.providerID}/${model.id}`,
    })
    // The proposal is stored before it is promoted: a rejected one stays reviewable with its reason.
    deps.repository.createProposal(input, now())
    const promoted = deps.curator.promote(proposal, now(), roster)
    if (!promoted.ok) {
      deps.repository.createProposal({ ...input, status: "rejected", reason: promoted.reason }, now())
      jobFor(episode, "skipped", { reason: promoted.reason, decisionID, proposalID: input.id })
      return
    }
    deps.repository.createProposal({ ...input, status: "promoted" }, now())
    jobFor(episode, "done", { reason: "promoted", decisionID, proposalID: input.id })
  }

  /** The deferred pass: the gate, the idempotence and the failure record all live here. */
  const reflect = async (episode: SessionEpisode): Promise<void> => {
    const config = deps.config()
    if (!config.enabled || !config.learning.enabled) return
    if (episode.endedAt === undefined) return
    if (deps.repository.getReflectionJob(episode.id)) return
    if (inFlight.has(episode.id)) return
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
        // The lifecycle (FH-042) ages every project the sweep saw: a window only moves when its own
        // episodes close, so the same listing that finds reflections finds what to graduate or
        // archive. `recompute` reconciles reverse collisions first. The state transitions are durable,
        // so a later sweep is a no-op and nothing is re-enqueued.
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
        hasJob: (episodeID) => deps.repository.getReflectionJob(episodeID) !== undefined,
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
