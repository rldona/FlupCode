/**
 * The shadow harness: decide on closed episodes, record, act on nothing (FH-017).
 *
 * A decision is computed from evidence that is already stored, after the episode is written, and it
 * can only write to `adaptive_decision` and `adaptive_plan`. That is the whole observable effect, and
 * it is zero: the episode, the run and the session are untouched, which is what the effect-zero test
 * asserts byte by byte.
 *
 * `completion` and `skillRelevance` are decided here; `contextItem` is delegated to the
 * `ContextManager`, which classifies the episode, plans it and asks Jev only about ambiguous items
 * (FH-023). The trigger is the coordinator's terminal callback plus a periodic sweep as a backstop;
 * both are fire-and-forget, and a failure to decide is reported and dropped rather than raised into
 * the close of an episode.
 */

import type { AdaptiveConfig } from "./config"
import type { DecisionPolicy, DecisionRequest } from "./decision"
import type { DecisionService } from "./decision-service"
import { planID } from "./compaction-plan"
import type { ContextManager } from "./context-manager"
import type { DecisionRepository, SessionEpisode, StoredPlan } from "../types"

/** The kinds the shadow itself decides; `contextItem` is the manager's (FH-023). */
export const SHADOW_KINDS = ["completion", "skillRelevance"] as const
export type ShadowKind = (typeof SHADOW_KINDS)[number]

/** One candidate skill for a relevance question; `learned` is the self-authored marker, later. */
export type SkillCandidate = { name: string; description: string; learned: boolean }

/** The roster a `skillRelevance` decision was offered and the names it selected (FH-043). */
export type SkillSelection = {
  projectID: string
  roster: readonly SkillCandidate[]
  loaded: readonly string[]
}

/** The names an answer loaded; anything that is not a string array is "selected nothing". */
function selectedSkills(answer: unknown): string[] {
  if (typeof answer !== "object" || answer === null) return []
  const load = (answer as { load?: unknown }).load
  return Array.isArray(load) ? load.filter((name): name is string => typeof name === "string") : []
}

/** A repository the shadow can read episodes from as well as write decisions and plans to. */
export type ShadowRepository = DecisionRepository & {
  listEpisodes(filter?: { limit?: number }): SessionEpisode[]
  getPlan(id: string): StoredPlan | undefined
}

export type ShadowRunner = {
  /** Fire-and-forget: it returns nothing and never throws toward the coordinator. */
  onEpisodeClosed(episode: SessionEpisode): void
  /** Restart backstop: terminal episodes with no decision or plan yet. */
  sweep(): number
  start(): void
  stop(): void
}

export function createShadowRunner(deps: {
  service: DecisionService
  repository: ShadowRepository
  config: () => AdaptiveConfig
  /** The context manager that owns `contextItem` and its plan (FH-023); absent means none is taken. */
  context?: ContextManager
  readSkills?: (episode: SessionEpisode) => SkillCandidate[]
  /**
   * Reports a `skillRelevance` selection so the learning loop can account its use (FH-043). It is
   * synchronous and fire-and-forget; a failure in it is reported and never reaches the episode.
   */
  trackSelection?: (selection: SkillSelection) => void
  onError?: (cause: unknown) => void
  sweepLimit?: number
}): ShadowRunner {
  const onError = deps.onError ?? (() => {})
  const readSkills = deps.readSkills ?? (() => [])
  const sweepLimit = deps.sweepLimit ?? 50

  /** One request per shadow kind, built from the episode; the policy comes from the config, per kind. */
  const requestFor = (
    kind: ShadowKind,
    episode: SessionEpisode,
    config: AdaptiveConfig,
    /** The roster, read once per close and shared by the request and its selection (FH-043). */
    skills: () => SkillCandidate[],
  ): DecisionRequest => {
    const policy: DecisionPolicy = config.decisions[kind]
    const base = { episodeID: episode.id, sessionID: episode.sessionID, projectID: episode.projectID, policy }
    switch (kind) {
      case "completion":
        return {
          ...base,
          kind,
          state: {
            episodeID: episode.id,
            objective: episode.objective,
            outcome: episode.outcome,
            toolCalls: episode.toolCalls,
            verifications: episode.verifications,
            failures: episode.failures.length,
            projectID: episode.projectID,
          },
        }
      case "skillRelevance":
        return {
          ...base,
          kind,
          state: { sessionID: episode.sessionID, objective: episode.objective, skills: skills() },
        }
    }
  }

  /**
   * Whether an episode still needs any adaptive work: a missing decision, or a missing plan.
   *
   * The plan clause is gated on `config.context.enabled`: with the context slice off no plan is ever
   * written, so counting it as outstanding would re-enqueue the episode on every sweep.
   */
  const needsWork = (episode: SessionEpisode, config: AdaptiveConfig): boolean =>
    SHADOW_KINDS.some((kind) => deps.repository.countDecisionsForEpisode(episode.id, kind) === 0) ||
    (deps.context !== undefined &&
      config.context.enabled &&
      deps.repository.getPlan(planID(episode.id)) === undefined)

  /** The adaptive work of one closed episode; the config is read once, in the task. */
  const decideClosed = async (episode: SessionEpisode, config: AdaptiveConfig): Promise<void> => {
    // The roster is filesystem I/O: memoized so the request and its selection share one read.
    let roster: SkillCandidate[] | undefined
    const skills = () => (roster ??= readSkills(episode))
    for (const kind of SHADOW_KINDS) {
      // A second close (a retried capture, another sweep) is already decided: the deterministic id
      // would converge the row anyway, but skipping it saves the call and keeps one decision.
      if (deps.repository.countDecisionsForEpisode(episode.id, kind) > 0) continue
      // One failing kind is reported and dropped; it never starves the kinds after it.
      const result = await deps.service.predict(requestFor(kind, episode, config, skills)).catch((cause) => {
        onError(cause)
        return undefined
      })
      // The selection is the usage signal; the same roster the request offered is handed to the tracker.
      if (kind === "skillRelevance" && result !== undefined && deps.trackSelection !== undefined) {
        const selection = { projectID: episode.projectID, roster: skills(), loaded: selectedSkills(result.answer) }
        deps.trackSelection(selection)
      }
    }
    // The plan is idempotent by id, but a second plan could spend on Jev again, so it is skipped.
    if (
      deps.context !== undefined &&
      config.context.enabled &&
      deps.repository.getPlan(planID(episode.id)) === undefined
    ) {
      await deps.context.planEpisode(episode).catch(onError)
    }
  }

  const onEpisodeClosed = (episode: SessionEpisode): void => {
    // Enqueue only. Building the request reads skills (filesystem I/O) and, with Jev off, the
    // decisions are written synchronously; both belong to this deferred task, never to the
    // coordinator's `writeRun`/`writeSession` path.
    void Promise.resolve()
      .then(() => {
        const config = deps.config()
        if (!config.enabled || !config.shadow) return
        return decideClosed(episode, config)
      })
      .catch(onError)
  }

  const sweep = (): number => {
    const config = deps.config()
    if (!config.enabled || !config.shadow) return 0
    try {
      return deps.repository
        .listEpisodes({ limit: sweepLimit })
        .filter((episode) => episode.endedAt !== undefined)
        .filter((episode) => needsWork(episode, config))
        .reduce((count, episode) => {
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
