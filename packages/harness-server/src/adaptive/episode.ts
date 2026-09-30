/**
 * A session that did something (FH-001).
 *
 * Runs and messages are separate records today: a run says it happened, a transcript says what was
 * said, and neither is "one session that pursued an objective and left evidence behind". An episode
 * is that unit — the seam the adaptive layer reads from (FH-002/FH-003 capture it, FH-005 extracts
 * its outcome). This module is only its shape and the defensive reading of what was stored.
 */

export const EPISODE_OUTCOMES = ["success", "partial", "failed", "unknown"] as const

export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number]

/** One thing that went wrong, anchored to a file and usually a line when it is known. */
export type EpisodeFailure = { summary: string; file?: string; line?: number }

/** One check that was run and whether it passed. */
export type EpisodeVerification = { step: string; ok: boolean }

export type EpisodeInput = {
  id?: string
  sessionID: string
  projectID: string
  runID?: string
  objective: string
  toolCalls: number
  files: string[]
  commands: string[]
  failures: EpisodeFailure[]
  verifications: EpisodeVerification[]
  /** Known when the episode is captured, or `unknown`: FH-002/FH-003 store before the outcome exists. */
  outcome?: EpisodeOutcome
  startedAt: number
  endedAt?: number
  evidenceRefs: string[]
}

export type SessionEpisode = {
  id: string
  sessionID: string
  projectID: string
  runID?: string
  objective: string
  toolCalls: number
  files: string[]
  commands: string[]
  failures: EpisodeFailure[]
  verifications: EpisodeVerification[]
  outcome: EpisodeOutcome
  startedAt: number
  endedAt?: number
  evidenceRefs: string[]
  timeCreated: number
  timeUpdated: number
}

export type EpisodeFilter = {
  projectID?: string
  sessionID?: string
  runID?: string
  limit?: number
}

/**
 * The `LIMIT` an episode filter asks for, or `undefined` for no limit.
 *
 * A filter may arrive from a query string, so a negative, fractional or non-finite count must read
 * as a value rather than reach SQLite: `NaN` and `Infinity` fail the binding, and `-1` would mean
 * "every row" by accident. Only a finite count at or above zero is honored, floored to an integer
 * and capped at `Number.MAX_SAFE_INTEGER`: a number past it is still finite, but SQLite cannot bind
 * it as an integer.
 */
export const normalizeEpisodeLimit = (limit: number | undefined): number | undefined => {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) return undefined
  return Math.min(Math.floor(limit), Number.MAX_SAFE_INTEGER)
}

/**
 * An outcome is one of four, or it is `unknown`.
 *
 * A row written by an older build, or edited by hand, must not make a reader see a fifth outcome:
 * "we could not tell" is already a value here, and a typo is not.
 */
export const normalizeOutcome = (value: unknown): EpisodeOutcome =>
  value === "success" || value === "partial" || value === "failed" ? value : "unknown"

/** A stored list of strings, or nothing. Broken JSON reads as empty rather than taking a read down. */
export function parseStringList(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

/** The failures worth keeping: one with no summary says nothing, so it is dropped. */
export function parseFailures(value: string | null): EpisodeFailure[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): EpisodeFailure[] => {
      if (!isPlainObject(entry) || typeof entry.summary !== "string") return []
      return [
        {
          summary: entry.summary,
          ...(typeof entry.file === "string" ? { file: entry.file } : {}),
          ...(typeof entry.line === "number" ? { line: entry.line } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/** The checks worth keeping: a step and its verdict are both required. */
export function parseVerifications(value: string | null): EpisodeVerification[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): EpisodeVerification[] => {
      if (!isPlainObject(entry) || typeof entry.step !== "string" || typeof entry.ok !== "boolean") return []
      return [{ step: entry.step, ok: entry.ok }]
    })
  } catch {
    return []
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// ---- episode boundaries (FH-002) -------------------------------------------------------------

/**
 * How episode boundaries are decided.
 *
 * Kept beside the model because it is the model's own question — when a session is one episode, and
 * when it is just the same episode seen again — and not the coordinator's.
 */
export type EpisodeBoundaryConfig = {
  cadenceCalls: number
  sweepMs: number
  backfillMs: number
  /**
   * Whether interactive sessions (the ones no harness run owns) become episodes too (AH-B03). Read
   * with the kill switch on every sweep: either one off and nothing is observed or written.
   */
  interactive: boolean
  /** How long an interactive session must stay quiet before its episode closes (AH-B03). */
  idleMs: number
  /** How many interactive sessions one sweep may close: the bound on volume and on engine lookups. */
  sessionLimit: number
}

export const DEFAULT_EPISODE_BOUNDARY_CONFIG: EpisodeBoundaryConfig = {
  cadenceCalls: 50,
  sweepMs: 30_000,
  backfillMs: 24 * 60 * 60 * 1000,
  interactive: true,
  idleMs: 15 * 60 * 1000,
  sessionLimit: 20,
}

const positiveNumberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * The boundary's settings, from the environment first, then `flupcode.adaptive.episode`, then
 * defaults — the same precedence `resolveRuntimeConfig` uses.
 */
export function resolveEpisodeBoundaryConfig(
  input: { block?: unknown; env?: NodeJS.ProcessEnv } = {},
): EpisodeBoundaryConfig {
  const env = input.env ?? process.env
  const block = isPlainObject(input.block) ? input.block : {}
  const episode = isPlainObject(block.episode) ? block.episode : {}
  const numberFrom = (envValue: string | undefined, blockValue: unknown, fallback: number) =>
    positiveNumberFrom(Number(envValue)) ?? positiveNumberFrom(blockValue) ?? fallback

  return {
    cadenceCalls: numberFrom(
      env.FLUPCODE_ADAPTIVE_EPISODE_CADENCE_CALLS,
      episode.cadenceCalls,
      DEFAULT_EPISODE_BOUNDARY_CONFIG.cadenceCalls,
    ),
    sweepMs: numberFrom(env.FLUPCODE_ADAPTIVE_EPISODE_SWEEP_MS, episode.sweepMs, DEFAULT_EPISODE_BOUNDARY_CONFIG.sweepMs),
    backfillMs: numberFrom(
      env.FLUPCODE_ADAPTIVE_EPISODE_BACKFILL_MS,
      episode.backfillMs,
      DEFAULT_EPISODE_BOUNDARY_CONFIG.backfillMs,
    ),
    interactive:
      env.FLUPCODE_ADAPTIVE_EPISODE_INTERACTIVE === "0"
        ? false
        : typeof episode.interactive === "boolean"
          ? episode.interactive
          : DEFAULT_EPISODE_BOUNDARY_CONFIG.interactive,
    idleMs: numberFrom(env.FLUPCODE_ADAPTIVE_EPISODE_IDLE_MS, episode.idleMs, DEFAULT_EPISODE_BOUNDARY_CONFIG.idleMs),
    sessionLimit: Math.ceil(
      numberFrom(
        env.FLUPCODE_ADAPTIVE_EPISODE_SESSION_LIMIT,
        episode.sessionLimit,
        DEFAULT_EPISODE_BOUNDARY_CONFIG.sessionLimit,
      ),
    ),
  }
}

export const RUN_EPISODE_PREFIX = "episode:run:"
export const SESSION_EPISODE_PREFIX = "episode:session:"

/** The one episode a run owns: the deterministic id is what makes a retried capture converge. */
export const runEpisodeID = (runID: string): string => `${RUN_EPISODE_PREFIX}${runID}`

/**
 * The episode a session that belongs to no run owns.
 *
 * An interactive session can hold several: each time it goes quiet one closes, and work after that
 * is a new objective. The first keeps the bare id; the n-th (n > 1) is suffixed with its position,
 * so a retried close converges on the same row.
 */
export const sessionEpisodeID = (sessionID: string, position = 1): string =>
  position > 1 ? `${SESSION_EPISODE_PREFIX}${sessionID}:${position}` : `${SESSION_EPISODE_PREFIX}${sessionID}`

const TERMINAL_RUN_STATUSES = ["success", "failed", "stopped"] as const

/** A run has settled once it will not change again; only then is its episode final. */
export const isTerminalRunStatus = (status: string): status is (typeof TERMINAL_RUN_STATUSES)[number] =>
  TERMINAL_RUN_STATUSES.some((terminal) => terminal === status)

/**
 * The outcome a run's status implies (FH-002), provisional until FH-005 extracts the real one.
 *
 * A stopped run did part of the work, so it is `partial`, not `failed`; a run still going says
 * nothing yet, which is `unknown`.
 */
export function outcomeForRun(status: string): EpisodeOutcome {
  if (status === "success") return "success"
  if (status === "failed") return "failed"
  if (status === "stopped") return "partial"
  return "unknown"
}

/**
 * Whether a capture should write.
 *
 * A terminal run is always written — that is the episode. A live one is only written once it has
 * moved on by `cadenceCalls` tool calls since the last capture, so a long session checkpoints now
 * and then instead of on every call, and a capture that would say the same thing is skipped.
 */
export function shouldCheckpoint(input: {
  previous: { toolCalls: number } | undefined
  toolCalls: number
  terminal: boolean
  cadenceCalls: number
}): boolean {
  if (input.terminal) return true
  if (!input.previous) return true
  return input.toolCalls - input.previous.toolCalls >= input.cadenceCalls
}
