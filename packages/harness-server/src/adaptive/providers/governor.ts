/**
 * The one composition the decision service consumes (FH-013/013b).
 *
 * It owns the circuit breaker, the monthly budget, the adaptive limiter and the single-flight map,
 * and exposes two entries that are isolated by construction rather than by convention: `runHot`
 * never acquires a limiter slot, so a saturating batch cannot delay a live turn; `runBatch` goes
 * through the limiter. Both share the same breaker, budget and single-flight map, but the key is
 * scoped per mode, so a live turn never joins an in-flight background batch; identical concurrent
 * questions inside the same mode collapse into one outbound call.
 *
 * The outcome is recorded once per flight, inside it: joiners share the answer and never multiply
 * breaker or limiter feedback. The budget is charged per attempt (the first before the call, each
 * retry through the gate handed to `work`) and its limits are read from the live config.
 *
 * The transport lives in each model and the retries in `retry.ts`; this module
 * knows about work, not about HTTP.
 */

import type { DecisionKind, DegradedReason } from "../decision"
import { createBreaker } from "./breaker"
import type { BreakerState } from "./breaker"
import { createBudget } from "./budget"
import type { BudgetStore } from "./budget"
import { createLimiter } from "./limiter"
import type { LimiterConfig } from "./limiter"
import { DecisionUnavailable, degradedReasonOf } from "./provider"
import { createSingleFlight } from "./single-flight"

export type GovernorConfig = {
  monthlyTokenBudget: number
  /** Fraction of the budget only the hot path may spend (default 0.2). */
  hotReserveFraction: number
  breakerFailures: number
  breakerCooldownMs: number
  limiter: LimiterConfig
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  monthlyTokenBudget: 100_000,
  hotReserveFraction: 0.2,
  breakerFailures: 5,
  breakerCooldownMs: 30_000,
  limiter: { initial: 2, max: 4, min: 1, restoreEvery: 8 },
}

export type GovernorStore = BudgetStore

export type GovernorLog =
  | { kind: "breaker"; state: BreakerState; at: number }
  | { kind: "rate-limited"; retryAfterMs?: number; concurrency: number }
  | { kind: "budget-exhausted"; month: string }
  | { kind: "soft-cap"; month: string }

export type GovernorState = {
  month: string
  tokensSpent: number
  breaker: BreakerState
  concurrency: number
  inflight: number
}

/**
 * The work a flight runs once. `retry` reserves one more attempt's estimate before a retry and
 * returns `false` when the budget cannot cover it.
 */
export type GovernedWork<T> = (signal: AbortSignal, retry: () => boolean) => Promise<T>

/**
 * `cap` is the asked provider's own monthly budget (PI-01), a lower limit on the shared month's spend;
 * without one the layer's budget is the only limit.
 */
export type Governor = {
  /** Hot path: no queue, only breaker and budget. */
  runHot<T>(key: string, tokens: number, work: GovernedWork<T>, cap?: number): Promise<T>
  /** Batch: adaptive concurrency, still sharing breaker, budget and single-flight with the hot path. */
  runBatch<T>(key: string, tokens: number, work: GovernedWork<T>, cap?: number): Promise<T>
  recordSuccess(): void
  recordFailure(reason: DegradedReason): void
  recordRateLimit(retryAfterMs?: number): void
  state(): GovernorState
}

/** The key single-flight and logging agree on: kind, redacted inputs and the model asked. */
export const governorKey = (kind: DecisionKind, inputsHash: string, modelID?: string): string =>
  `${kind}\u0000${inputsHash}\u0000${modelID ?? ""}`

/** Reasons that are the provider's fault; governance rejections never count toward the breaker. */
const BREAKER_REASONS: ReadonlySet<DegradedReason> = new Set([
  "timeout",
  "network",
  "rate-limited",
  "unauthorized",
  "malformed",
])

/** A settled flight that fell back: a wrapping provider (the FH-013 fallback) reports it this way. */
const isDegraded = (
  value: unknown,
): value is { degraded: true; degradedReason?: DegradedReason; retryAfterMs?: number } =>
  typeof value === "object" && value !== null && "degraded" in value && value.degraded === true

export function createGovernor(input: {
  /**
   * The live config. The budget limits are read on every reservation; the breaker and limiter keep
   * state, so their settings are taken once at construction.
   */
  config: () => GovernorConfig
  store: GovernorStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onLog?: (event: GovernorLog) => void
}): Governor {
  const now = input.now ?? Date.now
  const onLog = input.onLog
  const startup = input.config()
  const breaker = createBreaker({
    failures: startup.breakerFailures,
    cooldownMs: startup.breakerCooldownMs,
    now,
    onStateChange: (state) => onLog?.({ kind: "breaker", state, at: now() }),
  })
  const budget = createBudget({
    limits: () => {
      const config = input.config()
      return { monthlyTokens: config.monthlyTokenBudget, hotReserveFraction: config.hotReserveFraction }
    },
    store: input.store,
    now,
  })
  const limiter = createLimiter({ config: startup.limiter, now, sleep: input.sleep })
  const flight = createSingleFlight()
  let softCapLoggedFor: string | undefined

  /** Reserves the estimated spend, logs an exhausted budget, and reports the soft cap once a month. */
  const reserve = (tokens: number, mode: "hot" | "batch", cap?: number): boolean => {
    if (!budget.reserve(tokens, mode, cap)) {
      onLog?.({ kind: "budget-exhausted", month: budget.month() })
      return false
    }
    const month = budget.month()
    if (budget.remaining("hot") > 0 || softCapLoggedFor === month) return true
    softCapLoggedFor = month
    onLog?.({ kind: "soft-cap", month })
    return true
  }

  const recordSuccess = () => {
    breaker.recordSuccess()
    limiter.recordSuccess()
  }
  const recordFailure = (reason: DegradedReason) => {
    if (BREAKER_REASONS.has(reason)) breaker.recordFailure()
  }
  const recordRateLimit = (retryAfterMs?: number) => {
    limiter.recordRateLimit(retryAfterMs)
    onLog?.({ kind: "rate-limited", retryAfterMs, concurrency: limiter.concurrency() })
  }
  const recordDegraded = (reason: DegradedReason, retryAfterMs?: number) => {
    recordFailure(reason)
    // A 429 is a 429: the limiter backs off whether or not the provider named a `Retry-After`.
    if (reason === "rate-limited") recordRateLimit(retryAfterMs)
  }

  const run = async <T>(
    mode: "hot" | "batch",
    key: string,
    tokens: number,
    work: GovernedWork<T>,
    cap?: number,
  ): Promise<T> => {
    // Hot and batch never share an in-flight promise: a live turn must not join a background batch
    // and inherit its limiter wait (ADR-0017 §4). Breaker, budget and limiter stay shared below, and
    // the hot path keeps its own deadline. The accepted cost is that one identical question hot and
    // one batch no longer collapse into a single outbound call.
    return flight.run(`${mode}\u0000${key}`, async () => {
      // A refusing breaker is checked before the budget, so a refused call writes nothing to usage.
      if (!breaker.wouldAllow()) throw new DecisionUnavailable("breaker-open")
      // The reservation happens inside the flight: a deduped caller shares the answer and reserves
      // nothing, and the estimate is persisted before the call so a later failure still counts.
      if (!reserve(tokens, mode, cap)) throw new DecisionUnavailable("budget-exhausted")
      // Reserves the half-open probe only once the budget admitted the call, so an exhausted budget
      // never strands it. Nothing runs between `wouldAllow` and here, so this admits.
      breaker.allow()
      const controller = new AbortController()
      if (mode === "batch") await limiter.acquire()
      try {
        const value = await work(controller.signal, () => reserve(tokens, mode, cap))
        if (isDegraded(value)) recordDegraded(value.degradedReason ?? "network", value.retryAfterMs)
        else recordSuccess()
        return value
      } catch (error) {
        recordDegraded(degradedReasonOf(error), error instanceof DecisionUnavailable ? error.retryAfterMs : undefined)
        throw error
      } finally {
        if (mode === "batch") limiter.release()
      }
    })
  }

  return {
    runHot: (key, tokens, work, cap) => run("hot", key, tokens, work, cap),
    runBatch: (key, tokens, work, cap) => run("batch", key, tokens, work, cap),
    recordSuccess,
    recordFailure,
    recordRateLimit,
    state: () => ({
      month: budget.month(),
      tokensSpent: budget.spent().tokens,
      breaker: breaker.state(),
      concurrency: limiter.concurrency(),
      inflight: limiter.inflight(),
    }),
  }
}
