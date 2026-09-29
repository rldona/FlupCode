/**
 * The provider that always answers (FH-013).
 *
 * It wraps the external provider with the strict per-kind timeout and bounded retries that honour
 * `Retry-After`, and it turns any final failure — timeout, network, 429/529, 401, malformed — into
 * the deterministic answer with `degraded: true` and the reason. That is the whole point of the
 * phase: a Jev that is slow or down changes nothing a caller can observe except the reason it
 * carries, and the answer equals the deterministic provider byte for byte.
 *
 * The breaker, budget and limiter are not here: they are shared by hot and batch and live in the
 * governor, which the service composes around this provider. This module only owns the shape of a
 * no-throw provider result, so `onFailure`/`onSuccess` let the composition feed the governor without
 * this module having to know it exists.
 */

import type { DecisionKind, DecisionRequest, DegradedReason } from "../decision"
import { deterministicBaseline } from "./deterministic"
import { DecisionUnavailable } from "./provider"
import type { DecisionProvider, ProviderAnswer } from "./provider"

/**
 * The richer answer this provider hands the service.
 *
 * It extends `ProviderAnswer` with the transport outcome: `source`/`provider` say who actually
 * produced the answer, `attemptedProvider` names the external provider that was asked, and
 * `degraded`/`degradedReason` say whether the attempt had to fall back. The service reads these so a
 * degraded fallback is recorded as one instead of being mistaken for a Jev success.
 */
export type FallbackAnswer<Q extends DecisionKind = DecisionKind> = ProviderAnswer<Q> & {
  source: "jev" | "fallback"
  provider: string
  attemptedProvider: string
  degraded: boolean
  degradedReason?: DegradedReason
  baselineRule: string
}

export type FallbackProvider = {
  readonly id: string
  answer<Q extends DecisionKind>(request: DecisionRequest<Q>, signal: AbortSignal): Promise<FallbackAnswer<Q>>
}

type TimerHandle = ReturnType<typeof setTimeout>
type Timers = {
  set: (fn: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

/** A second try helps a transient timeout or a rate limit; a 401 never gets one. */
const RETRYABLE: ReadonlySet<DegradedReason> = new Set(["timeout", "network", "rate-limited"])

const reasonOf = (error: unknown): DegradedReason => {
  if (error instanceof DecisionUnavailable) return error.reason
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout"
  return "network"
}

export function createFallbackProvider(input: {
  external: DecisionProvider
  timeoutMsFor?: (request: DecisionRequest) => number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timers?: Timers
  onSuccess?: (latencyMs: number) => void
  onFailure?: (reason: DegradedReason, retryAfterMs?: number) => void
}): FallbackProvider {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timers = input.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) }
  const timeoutMsFor = input.timeoutMsFor ?? ((request) => request.policy.timeoutMs)
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3)
  const baseDelayMs = Math.max(0, input.baseDelayMs ?? 50)
  const maxDelayMs = Math.max(baseDelayMs, input.maxDelayMs ?? 2_000)

  const attempt = async <T>(
    work: (signal: AbortSignal) => Promise<T>,
    caller: AbortSignal,
    timeoutMs: number,
  ): Promise<T> => {
    if (timeoutMs <= 0) return work(caller)
    const controller = new AbortController()
    let timedOut = false
    const handle = timers.set(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      return await work(AbortSignal.any([caller, controller.signal]))
    } catch (error) {
      if (timedOut) throw new DecisionUnavailable("timeout")
      throw error
    } finally {
      timers.clear(handle)
    }
  }

  return {
    id: `fallback:${input.external.id}`,
    answer: async <Q extends DecisionKind>(request: DecisionRequest<Q>, signal: AbortSignal): Promise<FallbackAnswer<Q>> => {
      const startedAt = now()
      const baseline = deterministicBaseline(request)
      let attemptNumber = 0
      let lastReason: DegradedReason = "network"
      let lastRetryAfterMs: number | undefined

      while (attemptNumber < maxAttempts) {
        attemptNumber += 1
        try {
          const raw = await attempt(
            (signal) => input.external.answer(request, signal),
            signal,
            timeoutMsFor(request),
          )
          const latencyMs = now() - startedAt
          input.onSuccess?.(latencyMs)
          return {
            answer: raw.answer,
            source: "jev",
            provider: input.external.id,
            attemptedProvider: input.external.id,
            confidence: raw.confidence,
            probabilities: raw.probabilities,
            modelVersion: raw.modelVersion,
            latencyMs,
            degraded: false,
            baselineRule: baseline.rule,
          }
        } catch (error) {
          lastReason = reasonOf(error)
          lastRetryAfterMs = error instanceof DecisionUnavailable ? error.retryAfterMs : undefined
          // A caller that aborted its own deadline must not be retried: the hot path is bounded end to
          // end by that deadline, and a retry would wait past it. This does not affect a caller that is
          // still alive (the usual per-attempt timeout and bounded retries stand).
          if (signal.aborted) break
          if (attemptNumber >= maxAttempts || !RETRYABLE.has(lastReason)) break
          // A rate limit says exactly how long to wait; anything else backs off exponentially.
          const delay =
            lastRetryAfterMs !== undefined
              ? lastRetryAfterMs
              : Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs)
          await sleep(delay)
        }
      }

      const latencyMs = now() - startedAt
      input.onFailure?.(lastReason, lastRetryAfterMs)
      return {
        answer: baseline.answer,
        source: "fallback",
        provider: "deterministic",
        attemptedProvider: input.external.id,
        latencyMs,
        degraded: true,
        degradedReason: lastReason,
        baselineRule: baseline.rule,
      }
    },
  }
}
