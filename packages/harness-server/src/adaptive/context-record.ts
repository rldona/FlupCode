/**
 * The audit row of a context plan, encoded and decoded (FH-022).
 *
 * A plan is one row with a bounded `items_json`, mirroring `adaptive_decision` and its
 * `state_summary_json`. The row never holds content: entries carry opaque ids, scores, dispositions
 * and reasons only, and the objective is kept as a hash. Every JSON column is read defensively — a
 * row edited by hand or written by an older build must not take a reader down, and an entry with an
 * unknown kind or disposition is dropped rather than guessed at.
 */

import { createHash } from "node:crypto"
import type { ContextItemKind, DegradedReason, ItemDisposition, PlanScoreSource } from "./decision"
import { DEGRADED_REASONS, isContextItemKind, ITEM_DISPOSITIONS } from "./decision"
import type { ContextPlanEntry, StoredPlan, StoredPlanInput } from "../types"
import { LEGACY_PROVIDER, LEGACY_SOURCE } from "./legacy"

/** A plan never keeps more entries than this; the UI is deferred and the plan is one read. */
export const PLAN_ITEM_LIMIT = 200
/** The serialized entries may not grow past this; past it the tail is trimmed. */
export const PLAN_ITEMS_CHAR_LIMIT = 16_000

/** The objective is kept as a hash, never as text: the same rule the decision summary follows. */
export const objectiveHash = (objective: string): string => createHash("sha256").update(objective).digest("hex")

/** The shape SQLite hands back; every nullable column is `null`, never absent. */
export type PlanRow = {
  id: string
  run_id: string | null
  task_id: string | null
  episode_id: string | null
  session_id: string | null
  project_id: string | null
  objective_hash: string
  items_json: string
  item_count: number
  keep_count: number
  archive_count: number
  drop_count: number
  score_source: string
  /** The model that refined the plan (AH-C02); `null` for a scorer-only plan. */
  score_provider: string | null
  degraded: number
  degraded_reason: string | null
  applied: number
  tokens_before: number
  tokens_after: number
  decision_id: string | null
  truncated: number
  created_at: number
  updated_at: number
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The score source, reading the v1 vocabulary as the v2 one (AH-C02): the migration rewrites the
 * legacy source and `deterministic` once, and an older build started against a migrated database can
 * still write them afterwards.
 */
const readScoreSource = (row: PlanRow): { value: PlanScoreSource | "unknown"; provider?: string } => {
  const provider = row.score_provider ?? undefined
  if (row.score_source === LEGACY_SOURCE) return { value: "model", provider: provider ?? LEGACY_PROVIDER }
  if (row.score_source === "deterministic") return { value: "baseline" }
  if (row.score_source === "baseline" || row.score_source === "model")
    return { value: row.score_source, ...(provider ? { provider } : {}) }
  return { value: "unknown", ...(provider ? { provider } : {}) }
}

const isDisposition = (value: unknown): value is ItemDisposition =>
  typeof value === "string" && ITEM_DISPOSITIONS.some((candidate) => candidate === value)

const parseReason = (value: string | null): DegradedReason | undefined =>
  DEGRADED_REASONS.find((reason) => reason === value)

/**
 * Bounds the entries by count and by serialized characters. A plan that would not fit is trimmed
 * from the tail; the caller records that it happened and the bytes stay in their durable source.
 */
export function boundPlanEntries(
  entries: readonly ContextPlanEntry[],
  itemLimit = PLAN_ITEM_LIMIT,
  charLimit = PLAN_ITEMS_CHAR_LIMIT,
): ContextPlanEntry[] {
  const bounded = entries.slice(0, itemLimit)
  while (bounded.length > 0 && JSON.stringify(bounded).length > charLimit) bounded.pop()
  return bounded
}

/** The row as it is written: JSON fields serialized, absent optionals stored as `null`. */
export const planRowFrom = (input: StoredPlanInput, now: number): PlanRow => {
  const entries = boundPlanEntries(input.entries)
  const count = (disposition: ItemDisposition): number =>
    entries.filter((entry) => entry.disposition === disposition).length
  return {
    id: input.id,
    run_id: input.runID ?? null,
    task_id: input.taskID ?? null,
    episode_id: input.episodeID ?? null,
    session_id: input.sessionID ?? null,
    project_id: input.projectID ?? null,
    objective_hash: input.objectiveHash,
    items_json: JSON.stringify(entries),
    item_count: entries.length,
    keep_count: count("keep"),
    archive_count: count("archive"),
    drop_count: count("drop"),
    score_source: input.scoreSource,
    score_provider: input.scoreProvider ?? null,
    degraded: input.degraded ? 1 : 0,
    degraded_reason: input.degradedReason ?? null,
    applied: input.applied ? 1 : 0,
    tokens_before: input.tokensBefore,
    tokens_after: input.tokensAfter,
    decision_id: input.decisionID ?? null,
    truncated: entries.length < input.entries.length ? 1 : 0,
    created_at: now,
    updated_at: now,
  }
}

/** One entry read back, or none when it is not a shape the plan could have written. */
const parseEntry = (value: unknown): ContextPlanEntry | undefined => {
  if (!isPlainObject(value) || !isContextItemKind(value.kind) || !isDisposition(value.disposition)) return undefined
  const kind: ContextItemKind = value.kind
  return {
    id: typeof value.id === "string" ? value.id : "",
    kind,
    score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : 0,
    disposition: value.disposition,
    reason: typeof value.reason === "string" ? value.reason : "",
    protected: value.protected === true,
    tokens: typeof value.tokens === "number" && Number.isFinite(value.tokens) ? value.tokens : 0,
    ...(typeof value.evidenceRef === "string" ? { evidenceRef: value.evidenceRef } : {}),
  }
}

const parseEntries = (value: string): ContextPlanEntry[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      const decoded = parseEntry(entry)
      return decoded ? [decoded] : []
    })
  } catch {
    // A row edited by hand or written by an older build must not take a reader down.
    return []
  }
}

/**
 * The row as it is read: an unknown score source keeps the plan, reads `"unknown"` and exposes the
 * stored value in `rawScoreSource` (AH-C02), the same tolerance the decision audit has.
 */
export const planFromRow = (row: PlanRow): StoredPlan => {
  const source = readScoreSource(row)
  const degradedReason = parseReason(row.degraded_reason)
  return {
    id: row.id,
    ...(row.run_id ? { runID: row.run_id } : {}),
    ...(row.task_id ? { taskID: row.task_id } : {}),
    ...(row.episode_id ? { episodeID: row.episode_id } : {}),
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.project_id ? { projectID: row.project_id } : {}),
    objectiveHash: row.objective_hash,
    entries: parseEntries(row.items_json),
    scoreSource: source.value,
    ...(source.provider ? { scoreProvider: source.provider } : {}),
    ...(source.value === "unknown" ? { rawScoreSource: row.score_source } : {}),
    degraded: row.degraded !== 0,
    ...(degradedReason ? { degradedReason } : {}),
    applied: row.applied !== 0,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    ...(row.decision_id ? { decisionID: row.decision_id } : {}),
    truncated: row.truncated !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
