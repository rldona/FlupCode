/**
 * The circuit breaker that keeps one failing model from becoming a latency storm (FH-013).
 *
 * It is deliberately small and synchronous: consecutive failures open the circuit for a cooldown,
 * then exactly one probe is allowed through. A success closes it; a failed probe reopens it. The
 * clock is injected so the cooldown can be tested without waiting.
 */

export type BreakerState = "closed" | "open" | "half-open"

export type Breaker = {
  state(): BreakerState
  /** Whether this call may reach the provider; it reserves the single half-open probe. */
  allow(): boolean
  /** Whether `allow` would admit a call now, without reserving the probe. */
  wouldAllow(): boolean
  recordSuccess(): void
  recordFailure(): void
}

export function createBreaker(input: {
  failures: number
  cooldownMs: number
  now?: () => number
  onStateChange?: (state: BreakerState) => void
}): Breaker {
  const now = input.now ?? Date.now
  const failures = Math.max(1, input.failures)
  const cooldownMs = Math.max(0, input.cooldownMs)
  let current: BreakerState = "closed"
  let consecutiveFailures = 0
  let openedAt = 0
  let probeReserved = false

  const transition = (next: BreakerState) => {
    if (next === current) return
    current = next
    input.onStateChange?.(next)
  }

  const allow = (): boolean => {
    if (current === "open") {
      if (now() - openedAt < cooldownMs) return false
      transition("half-open")
    }
    if (current === "half-open") {
      if (probeReserved) return false
      probeReserved = true
      return true
    }
    return true
  }

  const wouldAllow = (): boolean => {
    if (current === "open") return now() - openedAt >= cooldownMs
    return current === "closed" || !probeReserved
  }

  const recordSuccess = () => {
    consecutiveFailures = 0
    probeReserved = false
    transition("closed")
  }

  const recordFailure = () => {
    if (current === "half-open") {
      probeReserved = false
      openedAt = now()
      transition("open")
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= failures) {
      openedAt = now()
      transition("open")
    }
  }

  /** Reports the half-open window as soon as the cooldown has passed, without consuming the probe. */
  const state = (): BreakerState => {
    if (current === "open" && now() - openedAt >= cooldownMs) return "half-open"
    return current
  }

  return { state, allow, wouldAllow, recordSuccess, recordFailure }
}
