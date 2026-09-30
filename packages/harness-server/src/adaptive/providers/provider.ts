/**
 * The typed failure a predictive model reports (FH-011, AH-C01).
 *
 * A model answers neutral questions (`../predictive/model`) or throws `DecisionUnavailable` with the
 * reason it could not; the service degrades to the deterministic baseline with that reason, so
 * `degraded` stays honest. The reason is also what the governor's breaker and limiter count.
 */

import type { DegradedReason } from "../decision"

/** A model that could not answer, with the reason that keeps `degraded` honest. */
export class DecisionUnavailable extends Error {
  /** How long the provider asked to wait before retrying, when it said so (`Retry-After`). */
  readonly retryAfterMs?: number

  constructor(readonly reason: DegradedReason, options: { retryAfterMs?: number; message?: string } = {}) {
    super(options.message ?? reason)
    this.name = "DecisionUnavailable"
    this.retryAfterMs = options.retryAfterMs
  }
}

/** The reason a thrown error degrades a decision: an aborted deadline is a timeout, not a network fault. */
export const degradedReasonOf = (error: unknown): DegradedReason => {
  if (error instanceof DecisionUnavailable) return error.reason
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout"
  return "network"
}
