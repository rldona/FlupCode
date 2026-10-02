/**
 * Bounded retries around a predictive model (FH-013, AH-C01).
 *
 * It wraps a model with the strict per-attempt timeout and bounded retries that honour a capped
 * `Retry-After`, and it rethrows the last failure — timeout, network, 429/529, 401, malformed — as
 * the model's own. The service turns that failure into the deterministic answer with `degraded: true`
 * and the reason, so a model that is slow or down changes nothing a caller can observe except the
 * reason it carries.
 *
 * The breaker, budget and limiter are not here: they are shared by hot and batch and live in the
 * governor, which the service composes around the model and which records the failure once per
 * flight. The governor threads the mode and a per-attempt budget gate through `PredictOptions`: a hot
 * call makes one attempt and never sleeps; a batch retry first accounts its attempt against the
 * budget and waits at most `maxDelayMs`, abort-aware.
 */

import type { DegradedReason } from "../decision"
import type { Prediction, PredictOptions, PredictiveModel } from "../predictive/model"
import { DecisionUnavailable, degradedReasonOf } from "./provider"

type TimerHandle = ReturnType<typeof setTimeout>
type Timers = {
  set: (fn: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

/** A second try helps a transient timeout or a rate limit; a 401 never gets one. */
const RETRYABLE: ReadonlySet<DegradedReason> = new Set(["timeout", "network", "rate-limited"])

export function createRetryingModel(input: {
  model: PredictiveModel
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Waits between attempts; it must settle as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timers?: Timers
}): PredictiveModel {
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
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3)
  const baseDelayMs = Math.max(0, input.baseDelayMs ?? 50)
  const maxDelayMs = Math.max(baseDelayMs, input.maxDelayMs ?? 2_000)

  /** One attempt, bounded by the per-attempt deadline; a deadline that fires is a `timeout`. */
  const attempt = async (
    work: (signal: AbortSignal) => Promise<Prediction>,
    caller: AbortSignal,
    timeoutMs: number,
  ) => {
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
    id: input.model.id,
    locality: input.model.locality,
    ...(input.model.name === undefined ? {} : { name: input.model.name }),
    ...(input.model.needsKey === undefined ? {} : { needsKey: input.model.needsKey }),
    ...(input.model.keySlot === undefined ? {} : { keySlot: input.model.keySlot }),
    supports: input.model.supports,
    predict: (state, questions, options: PredictOptions) => {
      // The hot path is bounded end to end by the caller's deadline: a retry could only wait past it.
      const attempts = options.mode === "hot" ? 1 : maxAttempts
      const run = async (attemptNumber: number): Promise<Prediction> => {
        try {
          return await attempt(
            (signal) => input.model.predict(state, questions, { ...options, signal }),
            options.signal,
            options.deadlineMs,
          )
        } catch (error) {
          // A caller that aborted must not be retried; a caller that is still alive keeps the usual
          // per-attempt timeout and bounded retries.
          if (options.signal.aborted || attemptNumber >= attempts || !RETRYABLE.has(degradedReasonOf(error)))
            throw error
          // A rate limit names its wait, anything else backs off exponentially; both are capped so a
          // `Retry-After: 30` cannot park a batch limiter slot for half a minute. The limiter still
          // pauses for the full `Retry-After`, which the rethrown failure carries to the governor.
          const retryAfterMs = error instanceof DecisionUnavailable ? error.retryAfterMs : undefined
          await sleep(Math.min(retryAfterMs ?? baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs), options.signal)
          if (options.signal.aborted) throw error
          // Every attempt spends: a retry the budget cannot cover is not made.
          if (options.retry && !options.retry()) throw error
          return run(attemptNumber + 1)
        }
      }
      return run(1)
    },
  }
}
