/**
 * The provider that always answers (FH-013).
 *
 * It wraps the external provider with the strict per-kind timeout and bounded retries that honour a
 * capped `Retry-After`, and it turns any final failure — timeout, network, 429/529, 401, malformed — into
 * the deterministic answer with `degraded: true` and the reason. That is the whole point of the
 * phase: a Jev that is slow or down changes nothing a caller can observe except the reason it
 * carries, and the answer equals the deterministic provider byte for byte.
 *
 * The breaker, budget and limiter are not here: they are shared by hot and batch and live in the
 * governor, which the service composes around this provider and which records the outcome this
 * provider reports once per flight. The governor threads the mode and a per-attempt budget gate
 * through `AttemptOptions`: a hot call makes one attempt and never sleeps; a batch retry first
 * accounts its attempt against the budget and waits at most `maxDelayMs`, abort-aware.
 */

import type { DecisionKind, DecisionRequest, DegradedReason } from "../decision"
import { deterministicBaseline } from "./deterministic"
import { DecisionUnavailable, degradedReasonOf } from "./provider"
import type { AttemptOptions, DecisionProvider, ProviderAnswer } from "./provider"

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
  answer<Q extends DecisionKind>(
    request: DecisionRequest<Q>,
    signal: AbortSignal,
    options?: AttemptOptions,
  ): Promise<FallbackAnswer<Q>>
}

type TimerHandle = ReturnType<typeof setTimeout>
type Timers = {
  set: (fn: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

/** A second try helps a transient timeout or a rate limit; a 401 never gets one. */
const RETRYABLE: ReadonlySet<DegradedReason> = new Set(["timeout", "network", "rate-limited"])

export function createFallbackProvider(input: {
  external: DecisionProvider
  timeoutMsFor?: (request: DecisionRequest) => number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
  /** Waits between attempts; it must settle as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timers?: Timers
}): FallbackProvider {
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(handle)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const handle = setTimeout(done, ms)
        signal.addEventListener("abort", done)
      }))
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
    answer: async <Q extends DecisionKind>(
      request: DecisionRequest<Q>,
      signal: AbortSignal,
      options: AttemptOptions = {},
    ): Promise<FallbackAnswer<Q>> => {
      const startedAt = now()
      const baseline = deterministicBaseline(request)
      // The hot path is bounded end to end by the caller's deadline: a retry could only wait past it.
      const attempts = options.mode === "hot" ? 1 : maxAttempts
      let attemptNumber = 0
      let lastReason: DegradedReason = "network"
      let lastRetryAfterMs: number | undefined

      while (attemptNumber < attempts) {
        attemptNumber += 1
        try {
          const raw = await attempt(
            (signal) => input.external.answer(request, signal),
            signal,
            timeoutMsFor(request),
          )
          const latencyMs = now() - startedAt
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
          lastReason = degradedReasonOf(error)
          lastRetryAfterMs = error instanceof DecisionUnavailable ? error.retryAfterMs : undefined
          // A caller that aborted must not be retried; a caller that is still alive keeps the usual
          // per-attempt timeout and bounded retries.
          if (signal.aborted) break
          if (attemptNumber >= attempts || !RETRYABLE.has(lastReason)) break
          // A rate limit names its wait, anything else backs off exponentially; both are capped so a
          // `Retry-After: 30` cannot park a batch limiter slot for half a minute. The limiter still
          // pauses for the full `Retry-After`, which the degraded answer carries to the governor.
          await sleep(Math.min(lastRetryAfterMs ?? baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs), signal)
          if (signal.aborted) break
          // Every attempt spends: a retry the budget cannot cover is not made.
          if (options.retry && !options.retry()) break
        }
      }

      const latencyMs = now() - startedAt
      return {
        answer: baseline.answer,
        source: "fallback",
        provider: "deterministic",
        attemptedProvider: input.external.id,
        latencyMs,
        degraded: true,
        degradedReason: lastReason,
        ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
        baselineRule: baseline.rule,
      }
    },
  }
}
