/**
 * The audit row of a decision, encoded and decoded (FH-015).
 *
 * The store keeps one row per deterministic id and every column that is JSON is read defensively:
 * a row edited by hand or written by an older build must not take a reader down, and a missing value
 * must read as missing rather than as a guess. The row never holds raw state — that invariant is
 * enforced by the writer (`EgressGuard.prepare`) and this module only serializes what it is handed.
 */

import type { DecisionKind, DecisionPolicy, DecisionSource, DegradedReason } from "./decision"
import { DEFAULT_DECISION_POLICY, isDecisionKind, isDecisionSource } from "./decision"
import type { StoredDecision, StoredDecisionInput } from "../types"

/** Deterministic id: a re-capture converges on the same row (the mirror of `runEpisodeID`). */
export const decisionID = (kind: DecisionKind, scopeID: string): string => `${kind}:${scopeID}`

/** The bound a redacted summary may reach before it is trimmed; a summary is not a transcript. */
export const SUMMARY_CHAR_LIMIT = 4_000

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The shape SQLite hands back; every nullable column is `null`, never absent. */
export type DecisionRow = {
  id: string
  session_id: string | null
  episode_id: string | null
  project_id: string | null
  kind: string
  inputs_hash: string
  state_summary_json: string
  answer_json: string
  baseline_answer_json: string
  baseline_rule: string
  confidence: number | null
  probabilities_json: string | null
  provider: string
  attempted_provider: string | null
  model_version: string | null
  source: string
  degraded: number
  degraded_reason: string | null
  latency_ms: number
  policy_json: string
  shadow: number
  created_at: number
  updated_at: number
}

const parseObject = (value: string | null): Record<string, unknown> => {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    // A row edited by hand or written by an older build must not take a reader down.
    return {}
  }
}

const parseUnknown = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const parseNumberMap = (value: string | null): Record<string, number> | undefined => {
  if (!value) return undefined
  const parsed = parseObject(value)
  const entries = Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

const parsePolicy = (value: string): DecisionPolicy => {
  const parsed = parseObject(value)
  return {
    allowJev: typeof parsed.allowJev === "boolean" ? parsed.allowJev : DEFAULT_DECISION_POLICY.allowJev,
    minConfidence:
      typeof parsed.minConfidence === "number" ? parsed.minConfidence : DEFAULT_DECISION_POLICY.minConfidence,
    minProbability:
      typeof parsed.minProbability === "number" ? parsed.minProbability : DEFAULT_DECISION_POLICY.minProbability,
    timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : DEFAULT_DECISION_POLICY.timeoutMs,
  }
}

const parseReason = (value: string | null): DegradedReason | undefined => {
  const reasons: DegradedReason[] = [
    "timeout",
    "network",
    "rate-limited",
    "unauthorized",
    "malformed",
    "low-confidence",
    "budget-exhausted",
    "breaker-open",
    "egress-denied",
    "provider-disabled",
  ]
  return reasons.find((reason) => reason === value)
}

/** Trims a summary to a bound so a chatty summarizer cannot turn the audit into a transcript. */
export const boundSummary = (summary: Record<string, unknown>, limit = SUMMARY_CHAR_LIMIT): Record<string, unknown> => {
  const serialized = JSON.stringify(summary)
  if (serialized.length <= limit) return summary
  return { truncated: true, bytes: serialized.length, fields: Object.keys(summary) }
}

/** An answer larger than any label set is not an answer; it is dropped to a bounded marker. */
export const ANSWER_CHAR_LIMIT = 4_000
export const boundAnswer = (value: unknown, limit = ANSWER_CHAR_LIMIT): unknown => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || serialized.length <= limit) return value
  return { truncated: true, bytes: serialized.length }
}

/** The row as it is written: JSON fields serialized, absent optionals stored as `null`. */
export const decisionRowFrom = (input: StoredDecisionInput, now: number): DecisionRow => ({
  id: input.id,
  session_id: input.sessionID ?? null,
  episode_id: input.episodeID ?? null,
  project_id: input.projectID ?? null,
  kind: input.kind,
  inputs_hash: input.inputsHash,
  state_summary_json: JSON.stringify(input.stateSummary),
  answer_json: JSON.stringify(input.answer),
  baseline_answer_json: JSON.stringify(input.baselineAnswer),
  baseline_rule: input.baselineRule,
  confidence: input.confidence ?? null,
  probabilities_json: input.probabilities ? JSON.stringify(input.probabilities) : null,
  provider: input.provider,
  attempted_provider: input.attemptedProvider ?? null,
  model_version: input.modelVersion ?? null,
  source: input.source,
  degraded: input.degraded ? 1 : 0,
  degraded_reason: input.degradedReason ?? null,
  latency_ms: input.latencyMs,
  policy_json: JSON.stringify(input.policy),
  shadow: input.shadow ? 1 : 0,
  created_at: now,
  updated_at: now,
})

/** The row as it is read: an unknown kind or source is dropped rather than guessed at. */
export const decisionFromRow = (row: DecisionRow): StoredDecision | undefined => {
  if (!isDecisionKind(row.kind) || !isDecisionSource(row.source)) return undefined
  const probabilities = parseNumberMap(row.probabilities_json)
  const degradedReason = parseReason(row.degraded_reason)
  return {
    id: row.id,
    kind: row.kind,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.episode_id ? { episodeID: row.episode_id } : {}),
    ...(row.project_id ? { projectID: row.project_id } : {}),
    inputsHash: row.inputs_hash,
    stateSummary: parseObject(row.state_summary_json),
    answer: parseUnknown(row.answer_json),
    baselineAnswer: parseUnknown(row.baseline_answer_json),
    baselineRule: row.baseline_rule,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(probabilities ? { probabilities } : {}),
    provider: row.provider,
    ...(row.attempted_provider ? { attemptedProvider: row.attempted_provider } : {}),
    ...(row.model_version ? { modelVersion: row.model_version } : {}),
    source: row.source,
    degraded: row.degraded !== 0,
    ...(degradedReason ? { degradedReason } : {}),
    latencyMs: row.latency_ms,
    policy: parsePolicy(row.policy_json),
    shadow: row.shadow !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
