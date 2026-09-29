/**
 * The adaptive limiter used by the batch path only (FH-013b).
 *
 * AIMD: a 429/529 halves the concurrency down to a floor and pauses until `Retry-After` has passed,
 * and every `restoreEvery` successes gives one slot back up to the ceiling. The hot path never
 * acquires a slot — it uses `runHot` — so a background batch cannot put the live turn behind it.
 */

export type LimiterConfig = { initial: number; max: number; min: number; restoreEvery: number }

export type Limiter = {
  /** Waits for a slot; never queues when the circuit is paused until the pause has passed. */
  acquire(): Promise<void>
  release(): void
  recordRateLimit(retryAfterMs?: number): void
  recordSuccess(): void
  concurrency(): number
  inflight(): number
  pausedUntil(): number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function createLimiter(input: {
  config: LimiterConfig
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Limiter {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const min = Math.max(1, input.config.min)
  const max = Math.max(min, input.config.max)
  const restoreEvery = Math.max(1, input.config.restoreEvery)

  let concurrency = clamp(input.config.initial, min, max)
  let current = 0
  let pauseUntil = 0
  let successes = 0
  const waiters: Array<() => void> = []
  let wake: Promise<void> | undefined

  const pump = () => {
    if (now() < pauseUntil) {
      if (waiters.length > 0 && !wake) {
        // One scheduled wake for the whole queue; every release would otherwise schedule its own.
        wake = sleep(Math.max(0, pauseUntil - now())).then(() => {
          wake = undefined
          pump()
        })
      }
      return
    }
    while (waiters.length > 0 && current < concurrency) {
      current += 1
      waiters.shift()?.()
    }
  }

  return {
    acquire: () => {
      if (now() >= pauseUntil && current < concurrency) {
        current += 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        pump()
      })
    },
    release: () => {
      current = Math.max(0, current - 1)
      pump()
    },
    recordRateLimit: (retryAfterMs) => {
      concurrency = clamp(Math.floor(concurrency / 2), min, max)
      successes = 0
      if (retryAfterMs !== undefined && retryAfterMs > 0) pauseUntil = Math.max(pauseUntil, now() + retryAfterMs)
    },
    recordSuccess: () => {
      successes += 1
      if (successes < restoreEvery) return
      successes = 0
      concurrency = clamp(concurrency + 1, min, max)
    },
    concurrency: () => concurrency,
    inflight: () => current,
    pausedUntil: () => pauseUntil,
  }
}
