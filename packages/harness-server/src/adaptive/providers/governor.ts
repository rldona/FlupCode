/**
 * The one composition the decision service consumes (FH-013/013b).
 *
 * It owns the circuit breaker, the monthly budget, the adaptive limiter and the single-flight map,
 * and exposes two entries that are isolated by construction rather than by convention: `runHot`
 * never acquires a limiter slot, so a saturating batch cannot delay a live turn; `runBatch` goes
 * through the limiter. Both share the same breaker, budget and in-flight map, so a background job
 * cannot open a second circuit or spend a second budget, and identical concurrent questions
 * collapse into one outbound call.
 *
 * The transport lives in `jev.ts` and the fallback in `fallback.ts`; this module knows about work,
 * not about HTTP.
 */

import type { DecisionKind, DegradedReason } from "../decision"
import { createBreaker } from "./breaker"
import type { BreakerState } from "./breaker"
import { createBudget } from "./budget"
import type { BudgetStore } from "./budget"
import { createLimiter } from "./limiter"
import type { LimiterConfig } from "./limiter"
import { DecisionUnavailable } from "./provider"
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

export type Governor = {
  /** Hot path: no queue, only breaker and budget. */
  runHot<T>(key: string, tokens: number, work: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Batch: adaptive concurrency, still sharing breaker, budget and single-flight with the hot path. */
  runBatch<T>(key: string, tokens: number, work: (signal: AbortSignal) => Promise<T>): Promise<T>
  recordSuccess(): void
  recordFailure(reason: DegradedReason): void
  recordRateLimit(retryAfterMs?: number): void
  state(): GovernorState
}

/** The key single-flight and logging agree on: kind, redacted inputs and pinned model. */
export const governorKey = (kind: DecisionKind, inputsHash: string, modelVersion?: string): string =>
  `${kind}\u0000${inputsHash}\u0000${modelVersion ?? ""}`

/** Reasons that are the provider's fault; governance rejections never count toward the breaker. */
const BREAKER_REASONS: ReadonlySet<DegradedReason> = new Set([
  "timeout",
  "network",
  "rate-limited",
  "unauthorized",
  "malformed",
])

export function createGovernor(input: {
  config: GovernorConfig
  store: GovernorStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onLog?: (event: GovernorLog) => void
}): Governor {
  const now = input.now ?? Date.now
  const onLog = input.onLog
  const breaker = createBreaker({
    failures: input.config.breakerFailures,
    cooldownMs: input.config.breakerCooldownMs,
    now,
    onStateChange: (state) => onLog?.({ kind: "breaker", state, at: now() }),
  })
  const budget = createBudget({
    monthlyTokens: input.config.monthlyTokenBudget,
    hotReserveFraction: input.config.hotReserveFraction,
    store: input.store,
    now,
  })
  const limiter = createLimiter({ config: input.config.limiter, now, sleep: input.sleep })
  const flight = createSingleFlight()
  let softCapLoggedFor: string | undefined

  const admit = (): DegradedReason | undefined => (breaker.allow() ? undefined : "breaker-open")

  /** Reserves the estimated spend, logs an exhausted budget, and reports the soft cap once a month. */
  const reserve = (tokens: number, mode: "hot" | "batch"): boolean => {
    if (!budget.reserve(tokens, mode)) {
      onLog?.({ kind: "budget-exhausted", month: budget.month() })
      return false
    }
    const month = budget.month()
    if (budget.remaining("hot") > 0 || softCapLoggedFor === month) return true
    softCapLoggedFor = month
    onLog?.({ kind: "soft-cap", month })
    return true
  }

  const run = async <T>(mode: "hot" | "batch", key: string, tokens: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    return flight.run(key, async () => {
      // The reservation happens inside the flight: a deduped caller shares the answer and reserves
      // nothing, and the estimate is persisted before the call so a later failure still counts.
      if (!reserve(tokens, mode)) throw new DecisionUnavailable("budget-exhausted")
      // The half-open probe is reserved only once the budget has admitted the call, so an early exit
      // can never strand a probe; a denial here never reserved one (see `Breaker.allow`).
      const denied = admit()
      if (denied) {
        budget.release(tokens)
        throw new DecisionUnavailable(denied)
      }
      const controller = new AbortController()
      if (mode === "batch") await limiter.acquire()
      try {
        return await work(controller.signal)
      } finally {
        if (mode === "batch") limiter.release()
      }
    })
  }

  return {
    runHot: (key, tokens, work) => run("hot", key, tokens, work),
    runBatch: (key, tokens, work) => run("batch", key, tokens, work),
    recordSuccess: () => {
      breaker.recordSuccess()
      limiter.recordSuccess()
    },
    recordFailure: (reason) => {
      if (BREAKER_REASONS.has(reason)) breaker.recordFailure()
    },
    recordRateLimit: (retryAfterMs) => {
      limiter.recordRateLimit(retryAfterMs)
      onLog?.({ kind: "rate-limited", retryAfterMs, concurrency: limiter.concurrency() })
    },
    state: () => ({
      month: budget.month(),
      tokensSpent: budget.spent().tokens,
      breaker: breaker.state(),
      concurrency: limiter.concurrency(),
      inflight: limiter.inflight(),
    }),
  }
}
