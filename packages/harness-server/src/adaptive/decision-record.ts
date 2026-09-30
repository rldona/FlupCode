/**
 * The audit row of a decision, encoded and decoded (FH-015).
 *
 * The store keeps one row per deterministic id and every column that is JSON is read defensively:
 * a row edited by hand or written by an older build must not take a reader down, and a missing value
 * must read as missing rather than as a guess. The row never holds raw state — that invariant is
 * enforced by the writer (`EgressGuard.prepare`) and this module only serializes what it is handed.
 */

import type { DecisionKind, DecisionLabel, DecisionPolicy, DecisionSource, DegradedReason } from "./decision"
import { DEFAULT_DECISION_POLICY, isDecisionKind, isDecisionLabelOutcome, isDecisionSource } from "./decision"
import type { StoredDecision, StoredDecisionInput } from "../types"
import { isArm } from "./holdout"

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
  arm: string | null
  provider_id: string | null
  provider_version: string | null
  cost_usd: number | null
  input_tokens: number | null
  /** `{ outcome, source }` as JSON (AH-C06); `labeled_at` is its own column so it can be queried. */
  label: string | null
  labeled_at: number | null
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
    // The failure/loop thresholds travel on the policy; a malformed one is dropped rather than guessed.
    ...(typeof parsed.repeatedCalls === "number" ? { repeatedCalls: parsed.repeatedCalls } : {}),
    ...(typeof parsed.repeatedErrors === "number" ? { repeatedErrors: parsed.repeatedErrors } : {}),
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
  arm: input.arm ?? null,
  provider_id: input.providerID ?? null,
  provider_version: input.providerVersion ?? null,
  cost_usd: input.costUsd ?? null,
  input_tokens: input.inputTokens ?? null,
  // The label has its own writer (AH-C06): the insert never sets it and the upsert leaves one alone.
  label: null,
  labeled_at: null,
  created_at: now,
  updated_at: now,
})

/**
 * The row as it is read (AH-C02): an unknown kind or source keeps the row, reads `"unknown"` and
 * exposes the stored value in `raw`, so a row written by a newer build is never lost from the audit.
 */
export const decisionFromRow = (row: DecisionRow): StoredDecision => {
  const source = readSource(row)
  const kind = isDecisionKind(row.kind) ? row.kind : "unknown"
  const raw = {
    ...(kind === "unknown" ? { kind: row.kind } : {}),
    ...(source.value === "unknown" ? { source: row.source } : {}),
  }
  const probabilities = parseNumberMap(row.probabilities_json)
  const degradedReason = parseReason(row.degraded_reason)
  const label = parseLabel(row.label, row.labeled_at)
  return {
    id: row.id,
    kind,
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
    source: source.value,
    ...(source.providerID ? { providerID: source.providerID } : {}),
    ...(row.provider_version ? { providerVersion: row.provider_version } : {}),
    ...(typeof row.cost_usd === "number" ? { costUsd: row.cost_usd } : {}),
    ...(typeof row.input_tokens === "number" ? { inputTokens: row.input_tokens } : {}),
    ...(label ? { label } : {}),
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
    degraded: row.degraded !== 0,
    ...(degradedReason ? { degradedReason } : {}),
    latencyMs: row.latency_ms,
    policy: parsePolicy(row.policy_json),
    shadow: row.shadow !== 0,
    ...(isArm(row.arm) ? { arm: row.arm } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The source, reading the v1 vocabulary as the v2 one (AH-C02).
 *
 * The migration rewrites `jev`/`deterministic` once, but an older build started against a migrated
 * database can still write them afterwards, and the schema version would not let the migration run
 * again. Reading them the way the migration maps them keeps those rows correct too.
 */
const readSource = (row: DecisionRow): { value: DecisionSource | "unknown"; providerID?: string } => {
  const providerID = row.provider_id ?? undefined
  if (row.source === "jev") return { value: "model", providerID: providerID ?? row.attempted_provider ?? row.provider }
  if (row.source === "deterministic") return { value: "baseline", ...(providerID ? { providerID } : {}) }
  return { value: isDecisionSource(row.source) ? row.source : "unknown", ...(providerID ? { providerID } : {}) }
}

/** A label is only read whole: an outcome this build does not know leaves the row unlabelled. */
const parseLabel = (value: string | null, labeledAt: number | null): DecisionLabel | undefined => {
  const parsed = parseObject(value)
  if (!isDecisionLabelOutcome(parsed.outcome) || typeof parsed.source !== "string" || labeledAt === null) return undefined
  return { outcome: parsed.outcome, source: parsed.source, labeledAt }
}
