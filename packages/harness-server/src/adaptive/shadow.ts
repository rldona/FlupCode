/**
 * The shadow harness: decide on closed episodes, record, act on nothing (FH-017).
 *
 * A decision is computed from evidence that is already stored, after the episode is written, and it
 * can only write to `adaptive_decision`. That is the whole observable effect, and it is zero: the
 * episode, the run and the session are untouched, which is what the effect-zero test asserts byte by
 * byte.
 *
 * The trigger is the coordinator's terminal callback plus a periodic sweep as a backstop. Both are
 * fire-and-forget: the coordinator does not wait, and a failure to decide is reported and dropped
 * rather than raised into the close of an episode.
 */

import { createHmac } from "node:crypto"
import type { AdaptiveConfig } from "./config"
import type { DecisionPolicy, DecisionRequest } from "./decision"
import { E2_KINDS } from "./decision"
import type { DecisionService } from "./decision-service"
import type { DecisionRepository, SessionEpisode } from "../types"

/** One candidate skill for a relevance question; `learned` is the self-authored marker, later. */
export type SkillCandidate = { name: string; description: string; learned: boolean }

/** A repository the shadow can read episodes from as well as write decisions to. */
export type ShadowRepository = DecisionRepository & {
  listEpisodes(filter?: { limit?: number }): SessionEpisode[]
}

export type ShadowRunner = {
  /** Fire-and-forget: it returns nothing and never throws toward the coordinator. */
  onEpisodeClosed(episode: SessionEpisode): void
  /** Restart backstop: terminal episodes with no decision yet. */
  sweep(): number
  start(): void
  stop(): void
}

/**
 * A stable, opaque reference for an observed value.
 *
 * Context item ids name what the episode touched, but a path, a command or a failure summary is
 * content: putting it in an id would ship it to Jev and keep it in the audit. The id is an HMAC under
 * the install's key — a keyless digest of a path or a command would be a dictionary oracle — so a
 * re-capture converges and `explain` shows a stable id, while the content stays in the episode and is
 * reached by `evidence_refs` (ADR-0017 §3). The key is never returned or logged.
 */
const opaqueItemID = (kind: "file" | "command" | "failure", value: string, key: Buffer): string =>
  `${kind}:${createHmac("sha256", key).update(value).digest("hex").slice(0, 16)}`

/** The context items E2 can name from what the episode already carries, always by opaque id. */
const contextItems = (episode: SessionEpisode, key: Buffer) => [
  ...episode.files.map((path) => ({ id: opaqueItemID("file", path, key), kind: "file", tokens: 0, referenced: true })),
  ...episode.commands.map((command) => ({
    id: opaqueItemID("command", command, key),
    kind: "command",
    tokens: 0,
    referenced: true,
  })),
  ...episode.failures.map((failure) => ({
    id: opaqueItemID("failure", failure.summary, key),
    kind: "failure",
    tokens: 0,
    referenced: true,
  })),
]

export function createShadowRunner(deps: {
  service: DecisionService
  repository: ShadowRepository
  config: () => AdaptiveConfig
  /** The install's key for opaque ids; never exported or logged. */
  opaqueKey: () => Buffer
  readSkills?: (episode: SessionEpisode) => SkillCandidate[]
  onError?: (cause: unknown) => void
  sweepLimit?: number
}): ShadowRunner {
  const onError = deps.onError ?? (() => {})
  const readSkills = deps.readSkills ?? (() => [])
  const sweepLimit = deps.sweepLimit ?? 50

  /** One request per E2 kind, built from the episode; the policy comes from the config, per kind. */
  const requestFor = (
    kind: (typeof E2_KINDS)[number],
    episode: SessionEpisode,
    config: AdaptiveConfig,
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
          state: { sessionID: episode.sessionID, objective: episode.objective, skills: readSkills(episode) },
        }
      case "contextItem":
        return { ...base, kind, state: { objective: episode.objective, items: contextItems(episode, deps.opaqueKey()) } }
    }
  }

  /** The E2 decisions of one closed episode, in order; the config is read once, in the task. */
  const decideClosed = async (episode: SessionEpisode, config: AdaptiveConfig): Promise<void> => {
    for (const kind of E2_KINDS) {
      // A second close (a retried capture, another sweep) is already decided: the deterministic id
      // would converge the row anyway, but skipping it saves the call and keeps one decision.
      if (deps.repository.countDecisionsForEpisode(episode.id, kind) > 0) continue
      // One failing kind is reported and dropped; it never starves the kinds after it.
      await deps.service.predict(requestFor(kind, episode, config)).catch(onError)
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
        .filter((episode) => E2_KINDS.some((kind) => deps.repository.countDecisionsForEpisode(episode.id, kind) === 0))
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
