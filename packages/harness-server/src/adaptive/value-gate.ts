/**
 * The value-of-information gate (AH-C05, audit §6.4).
 *
 * A predictive model only adds value when it disagrees with the baseline and is right. The gate keeps
 * rolling stats per (kind, model, model version) over the last `window` labelled decisions the model
 * answered: `disagreementRate`, the share whose answer differs from the baseline's, and
 * `uplift = acc(model | disagree) − acc(baseline | disagree)`, both read from the audit's labels
 * (AH-C06). The service asks the model only when
 *
 *     disagreementRate × uplift × valueOfCorrect > mean cost_usd + latencyCostUsdPerSecond × mean latency
 *
 * After the warm-up (`minSamples`), a model whose uplift is at most ε is paused for the kind, and one
 * that helps but does not pay for itself only sees exploration traffic. Either way a deterministic
 * ~5% exploration sample (a hash of the decision's scope) still reaches the model, so its stats keep
 * moving and the pause can lift. On the hot path the model is also skipped when its measured p95
 * latency exceeds the request deadline.
 *
 * The stats are refreshed at most once per `statsTtlMs` per (kind, model), from bounded queries, so the
 * hot path reads a cached number. A version change starts the stats from zero: only the newest
 * version's rows are read. The gate also keeps a bounded LRU of the model's answers by inputs hash, so
 * the same prepared input asked of the same model version within the kind's TTL is not asked again.
 */

import { createHash } from "node:crypto"
import type { AdaptiveConfig, VoiConfig } from "./config"
import { isDecisionKind } from "./decision"
import type { DecisionKind, DecisionLabelOutcome, DegradedReason } from "./decision"
import type { StoredDecision } from "../types"

/** What the audit holds for one kind and model: its newest version, that version's labels and calls. */
export type ValueSamples = {
  version?: string
  labeled: Array<Pick<StoredDecision, "answer" | "baselineAnswer" | "label">>
  calls: Array<{ latencyMs: number; costUsd?: number }>
}

export type ValueGateRepository = {
  listValueSamples(input: { kind: DecisionKind; providerID: string; limit: number }): ValueSamples
}

/**
 * `warming-up`: too few samples to judge, so the model is always asked. `asking`: its expected value
 * covers its cost. `exploring`: it helps, but not enough to pay for itself, so only the exploration
 * sample reaches it. `paused`: its uplift is at most ε — it does not improve the decision — and only
 * the exploration sample reaches it until the stats say otherwise.
 */
export type GateState = "warming-up" | "asking" | "exploring" | "paused"

export type ValueStats = {
  samples: number
  disagreements: number
  disagreementRate: number
  uplift: number
}

export type ValueGateStatus = ValueStats & {
  kind: DecisionKind
  modelID: string
  modelVersion?: string
  state: GateState
  /** `disagreementRate × uplift × valueOfCorrect`, in USD per decision. */
  valueUsd: number
  /** The recent mean cost plus the priced mean latency, in USD per decision. */
  costUsd: number
  p95LatencyMs?: number
  latencySamples: number
}

export type GateVerdict =
  | { ask: true; explored: boolean }
  | { ask: false; reason: Extract<DegradedReason, "voi-paused" | "voi-below-cost" | "p95-over-deadline"> }

/** A model's answer as the cache keeps it: the typed answer, what it reported and which version gave it. */
export type CachedPrediction = {
  answer: unknown
  providerID: string
  version?: string
  confidence?: number
  probabilities?: Record<string, number>
}

export type ValueGate = {
  /** Whether to ask the model; `deadlineMs` is the hot deadline, absent for a batch decision. */
  verdict(input: { kind: DecisionKind; modelID: string; scopeID: string; deadlineMs?: number }): GateVerdict
  recall(kind: DecisionKind, modelID: string, inputsHash: string): CachedPrediction | undefined
  remember(kind: DecisionKind, modelID: string, inputsHash: string, prediction: CachedPrediction): void
  /** The gate of every kind a model is assigned to, with the numbers it is judged by. */
  status(): ValueGateSnapshot
}

export type ValueGateSnapshot = Pick<VoiConfig, "enabled" | "window" | "minSamples" | "epsilon" | "explorationRate"> & {
  kinds: ValueGateStatus[]
}

/** Fewer latency samples than this say nothing about a p95. */
export const P95_MIN_SAMPLES = 20

export function createValueGate(deps: {
  repository: ValueGateRepository
  config: () => AdaptiveConfig
  now?: () => number
}): ValueGate {
  const now = deps.now ?? Date.now
  const stats = new Map<string, { at: number; status: ValueGateStatus }>()
  const cache = new Map<string, { at: number; prediction: CachedPrediction }>()

  const statusFor = (kind: DecisionKind, modelID: string): ValueGateStatus => {
    const key = `${kind}\u0000${modelID}`
    const voi = deps.config().voi
    const hit = stats.get(key)
    if (hit && now() - hit.at < voi.statsTtlMs) return hit.status
    const status = gateStatus({ kind, modelID, samples: readSamples(deps.repository, kind, modelID, voi.window), voi })
    stats.set(key, { at: now(), status })
    return status
  }

  const verdict: ValueGate["verdict"] = (input) => {
    const voi = deps.config().voi
    if (!voi.enabled) return { ask: true, explored: false }
    const reason = skipReason(statusFor(input.kind, input.modelID), input.deadlineMs)
    if (reason === undefined) return { ask: true, explored: false }
    if (explores(input.scopeID, input.kind, input.modelID, voi.explorationRate)) return { ask: true, explored: true }
    return { ask: false, reason }
  }

  const recall: ValueGate["recall"] = (kind, modelID, inputsHash) => {
    const voi = deps.config().voi
    const ttl = voi.kinds[kind].cacheTtlMs
    if (!voi.enabled || ttl === 0) return undefined
    const key = `${kind}\u0000${modelID}\u0000${inputsHash}`
    const entry = cache.get(key)
    if (!entry) return undefined
    cache.delete(key)
    // A new model version answers afresh: the cache never serves an answer from an older one.
    if (now() - entry.at >= ttl || entry.prediction.version !== statusFor(kind, modelID).modelVersion) return undefined
    // Re-inserting keeps the Map in least-recently-used order.
    cache.set(key, entry)
    return entry.prediction
  }

  const remember: ValueGate["remember"] = (kind, modelID, inputsHash, prediction) => {
    const voi = deps.config().voi
    if (!voi.enabled || voi.kinds[kind].cacheTtlMs === 0) return
    // A version the stats have not seen yet resets them on the next read rather than after the TTL.
    const statsKey = `${kind}\u0000${modelID}`
    if (stats.get(statsKey)?.status.modelVersion !== prediction.version) stats.delete(statsKey)
    const key = `${kind}\u0000${modelID}\u0000${inputsHash}`
    cache.delete(key)
    cache.set(key, { at: now(), prediction })
    const excess = cache.size - voi.cacheMaxEntries
    if (excess > 0) [...cache.keys()].slice(0, excess).forEach((stale) => cache.delete(stale))
  }

  const status: ValueGate["status"] = () => {
    const config = deps.config()
    return {
      enabled: config.voi.enabled,
      window: config.voi.window,
      minSamples: config.voi.minSamples,
      epsilon: config.voi.epsilon,
      explorationRate: config.voi.explorationRate,
      kinds: Object.entries(config.models).flatMap(([kind, modelID]) =>
        isDecisionKind(kind) && modelID !== undefined ? [statusFor(kind, modelID)] : [],
      ),
    }
  }

  return { verdict, recall, remember, status }
}

/** The rolling stats over labelled decisions; only rows whose label judged both answers count. */
export function valueStats(
  labeled: readonly Pick<StoredDecision, "answer" | "baselineAnswer" | "label">[],
): ValueStats {
  const judged = labeled.flatMap((row) => {
    const outcome = row.label?.outcome
    const baselineOutcome = row.label?.baselineOutcome
    if (!isJudged(outcome) || !isJudged(baselineOutcome)) return []
    return [{ disagrees: canonical(row.answer) !== canonical(row.baselineAnswer), outcome, baselineOutcome }]
  })
  const disagreeing = judged.filter((row) => row.disagrees)
  const accuracy = (pick: (row: (typeof disagreeing)[number]) => DecisionLabelOutcome) =>
    disagreeing.length === 0 ? 0 : disagreeing.filter((row) => pick(row) === "correct").length / disagreeing.length
  return {
    samples: judged.length,
    disagreements: disagreeing.length,
    disagreementRate: judged.length === 0 ? 0 : disagreeing.length / judged.length,
    // A model that never disagrees cannot add anything, so no disagreement is no uplift.
    uplift: accuracy((row) => row.outcome) - accuracy((row) => row.baselineOutcome),
  }
}

/** One kind and model's gate, from its samples and the config. */
export function gateStatus(input: {
  kind: DecisionKind
  modelID: string
  samples: ValueSamples
  voi: VoiConfig
}): ValueGateStatus {
  const weights = input.voi.kinds[input.kind]
  const stats = valueStats(input.samples.labeled)
  const latencies = input.samples.calls.map((call) => call.latencyMs)
  const costs = input.samples.calls.flatMap((call) => (call.costUsd !== undefined ? [call.costUsd] : []))
  const valueUsd = stats.disagreementRate * stats.uplift * weights.valueOfCorrect
  const costUsd = mean(costs) + (weights.latencyCostUsdPerSecond * mean(latencies)) / 1000
  const p95 = percentile(latencies, 0.95)
  const state: GateState =
    stats.samples < input.voi.minSamples
      ? "warming-up"
      : stats.uplift <= input.voi.epsilon
        ? "paused"
        : valueUsd > costUsd
          ? "asking"
          : "exploring"
  return {
    kind: input.kind,
    modelID: input.modelID,
    ...(input.samples.version !== undefined ? { modelVersion: input.samples.version } : {}),
    state,
    ...stats,
    valueUsd,
    costUsd,
    ...(p95 !== undefined ? { p95LatencyMs: p95 } : {}),
    latencySamples: latencies.length,
  }
}

/**
 * Whether a gated decision still goes to the model, as the exploration sample: a stable hash of the
 * decision's scope, kind and model, so a retry of the same decision makes the same choice.
 */
export function explores(scopeID: string, kind: DecisionKind, modelID: string, rate: number): boolean {
  const bucket = createHash("sha256").update(`voi:${kind}:${modelID}:${scopeID}`).digest().readUInt32BE(0) / 2 ** 32
  return bucket < rate
}

/** The artifacts-bearer GET behind `/harness/adaptive/voi`: the gate of every assigned kind. */
export function handleValueGateRead(gate: ValueGate): Response {
  return new Response(JSON.stringify({ data: gate.status() }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })
}

function skipReason(status: ValueGateStatus, deadlineMs: number | undefined) {
  if (status.state === "paused") return "voi-paused" as const
  if (status.state === "exploring") return "voi-below-cost" as const
  if (
    deadlineMs !== undefined &&
    status.p95LatencyMs !== undefined &&
    status.latencySamples >= P95_MIN_SAMPLES &&
    status.p95LatencyMs > deadlineMs
  )
    return "p95-over-deadline" as const
  return undefined
}

function readSamples(
  repository: ValueGateRepository,
  kind: DecisionKind,
  modelID: string,
  limit: number,
): ValueSamples {
  try {
    return repository.listValueSamples({ kind, providerID: modelID, limit })
  } catch {
    // An unreadable audit must not fail a decision: no samples is the warm-up, which asks the model
    // exactly as before the gate existed.
    return { labeled: [], calls: [] }
  }
}

const isJudged = (outcome: DecisionLabelOutcome | undefined): outcome is "correct" | "incorrect" =>
  outcome === "correct" || outcome === "incorrect"

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** The nearest-rank percentile, or nothing without samples. */
function percentile(values: readonly number[], rank: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)]
}

/**
 * An answer in a form where two equal answers read the same: object keys sorted, and arrays sorted
 * too, because every answer's arrays are sets (the skills to load, the item dispositions).
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
