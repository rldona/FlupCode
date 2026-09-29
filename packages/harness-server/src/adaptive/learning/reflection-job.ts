/**
 * The deterministic gate a closed episode must clear before anything is reflected (FH-030).
 *
 * Reflection is the first place an episode can cost a model call, and an idle session must cost
 * nothing. The gate is therefore decided here, with no model, no egress and no store: an episode
 * reaches the cadence (`minToolCalls`) **and** left at least one bounded, non-obvious signal — a
 * verification, a touched file or a failure — or no job is ever scheduled. Cadence is a safety net,
 * not the trigger; a quiet episode produces zero jobs, a busy one at most one.
 *
 * This module is the pure half of the reflection job: the gate, the signals it reads and the
 * defensive reading of the `reflection_job` row. The scheduler that persists a job and calls a model
 * is the `LearningManager` (FH-034); nothing here touches the filesystem or a database.
 */

import type { LearningConfig } from "../config"
import { normalizeEpisodeLimit } from "../episode"
import type { SessionEpisode } from "../episode"

// ---- the gate (FH-030) ------------------------------------------------------------------------

export const REFLECTION_STATUSES = ["pending", "skipped", "done", "failed"] as const
export type ReflectionStatus = (typeof REFLECTION_STATUSES)[number]

export const isReflectionStatus = (value: unknown): value is ReflectionStatus =>
  REFLECTION_STATUSES.some((status) => status === value)

/** Why an episode was left unreflected by the deterministic gate; both cost nothing. */
export const REFLECTION_GATE_REASONS = ["below-threshold", "no-signal"] as const
export type ReflectionGateReason = (typeof REFLECTION_GATE_REASONS)[number]

export type ReflectionGate = { reflect: true } | { reflect: false; reason: ReflectionGateReason }

/** How many signals an episode offers to the gate; enough to prove it did something, not an index. */
export const REFLECTION_SIGNAL_LIMIT = 20

/**
 * The bounded, non-obvious signals an episode left, in a stable order.
 *
 * Only what says the session actually did something: checks it ran, files it touched, and things that
 * went wrong. Commands are left out — a command is not evidence it produced a lesson on its own, and
 * the design names the other three.
 */
export function reflectionSignals(episode: SessionEpisode): string[] {
  return [
    ...episode.verifications.map((verification) => `verify:${verification.step} ${verification.ok ? "ok" : "fail"}`),
    ...episode.files.map((file) => `file:${file}`),
    ...episode.failures.map((failure) => `failure:${failure.summary}`),
  ].slice(0, REFLECTION_SIGNAL_LIMIT)
}

/** Whether one episode clears the gate, and when it does not, which half of it failed. */
export function reflectionGate(episode: SessionEpisode, config: LearningConfig): ReflectionGate {
  if (episode.toolCalls < config.minToolCalls) return { reflect: false, reason: "below-threshold" }
  if (reflectionSignals(episode).length === 0) return { reflect: false, reason: "no-signal" }
  return { reflect: true }
}

export type ReflectionBatch = {
  /** The episodes worth a job, in the order they were given. */
  reflect: SessionEpisode[]
  /** The ones the gate left alone, with the reason the scheduler records. */
  skipped: Array<{ episodeID: string; reason: ReflectionGateReason }>
}

/**
 * The gate applied across a sweep, so the golden assertion is one call: silence yields no `reflect`
 * entry at all, and a busy episode yields exactly one.
 */
export function reflectionGateBatch(episodes: readonly SessionEpisode[], config: LearningConfig): ReflectionBatch {
  const reflect: SessionEpisode[] = []
  const skipped: ReflectionBatch["skipped"] = []
  for (const episode of episodes) {
    const gate = reflectionGate(episode, config)
    if (gate.reflect) reflect.push(episode)
    else skipped.push({ episodeID: episode.id, reason: gate.reason })
  }
  return { reflect, skipped }
}

/** How many episodes one sweep considers, so a restart cannot walk an unbounded history. */
export const DEFAULT_REFLECTION_SWEEP_LIMIT = 50

/**
 * The episodes a sweep should reflect on: terminal (they have an `endedAt`) and with no job yet.
 *
 * This is the same criterion the Phase 2 shadow uses, and the job primary key is what makes "already
 * tried" a fact: an episode with a job — done, skipped or failed — is never reconsidered, so the
 * sweep neither re-reflects nor re-spends.
 */
export function reflectionCandidates(input: {
  episodes: readonly SessionEpisode[]
  hasJob: (episodeID: string) => boolean
  limit?: number
}): SessionEpisode[] {
  const limit = normalizeEpisodeLimit(input.limit) ?? DEFAULT_REFLECTION_SWEEP_LIMIT
  return input.episodes
    .filter((episode) => episode.endedAt !== undefined)
    .filter((episode) => !input.hasJob(episode.id))
    .slice(0, limit)
}

// ---- the stored job (FH-030) ------------------------------------------------------------------

/**
 * One reflection job, one per episode. The `episode_id` is the primary key, so a second close or a
 * sweep converges on the same row instead of spending twice; a job is terminal after its first try.
 */
export type StoredReflectionJob = {
  episodeID: string
  sessionID?: string
  projectID?: string
  status: ReflectionStatus
  /** A machine-readable why: `below-threshold`, `no-signal`, `egress-denied`, `no-model`, … */
  reason?: string
  decisionID?: string
  proposalID?: string
  attempts: number
  createdAt: number
  updatedAt: number
}

export type StoredReflectionJobInput = Omit<StoredReflectionJob, "createdAt" | "updatedAt">

export type ReflectionJobFilter = {
  projectID?: string
  status?: ReflectionStatus
  limit?: number
}

/** The shape SQLite hands back; every nullable column is `null`, never absent. */
export type ReflectionRow = {
  episode_id: string
  session_id: string | null
  project_id: string | null
  status: string
  reason: string | null
  decision_id: string | null
  proposal_id: string | null
  attempts: number
  created_at: number
  updated_at: number
}

/** The row as it is written: absent optionals stored as `null`. */
export const reflectionJobRowFrom = (input: StoredReflectionJobInput, now: number): ReflectionRow => ({
  episode_id: input.episodeID,
  session_id: input.sessionID ?? null,
  project_id: input.projectID ?? null,
  status: input.status,
  reason: input.reason ?? null,
  decision_id: input.decisionID ?? null,
  proposal_id: input.proposalID ?? null,
  attempts: input.attempts,
  created_at: now,
  updated_at: now,
})

/** The row as it is read: an unknown status is dropped rather than guessed at. */
export const reflectionJobFromRow = (row: ReflectionRow): StoredReflectionJob | undefined => {
  if (!isReflectionStatus(row.status)) return undefined
  return {
    episodeID: row.episode_id,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.project_id ? { projectID: row.project_id } : {}),
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.decision_id ? { decisionID: row.decision_id } : {}),
    ...(row.proposal_id ? { proposalID: row.proposal_id } : {}),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
