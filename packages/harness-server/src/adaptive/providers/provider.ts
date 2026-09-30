/**
 * The seam an external decision provider plugs into (FH-011).
 *
 * The provider answers a typed question and nothing more: it returns the raw answer with its
 * confidence and probabilities, and it does **not** apply thresholds — that is the service's job,
 * with `DecisionPolicy`. Keeping the seam that thin means recalibrating a threshold never touches the
 * adapter and never changes a cached answer's inputs hash.
 *
 * `NullProvider` fills the external slot when nothing is configured, so "Jev off" is a representable
 * provider rather than an absent one.
 */

import type { DecisionKind, DecisionRequest, DecisionSpec, DegradedReason } from "../decision"

export type ProviderAnswer<Q extends DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  /**
   * The provider's own confidence in the answer it chose, when it reports one. Never a positive-class
   * probability: a binary `p(yes)` goes in `probabilities`, and the service derives the chosen
   * answer's probability from there (`chosenProbability` in `decision-service.ts`).
   */
  confidence?: number
  /** A distribution over the answer's labels, or one `p(yes)` per gate for gate kinds. */
  probabilities?: Record<string, number>
  modelVersion?: string
  latencyMs: number
  /**
   * Transport metadata, set only by a provider that wraps resilience (the FH-013 fallback).
   *
   * A provider that answers directly leaves these absent: then the answer is the provider's own and
   * the service records it as a success. The fallback sets them so the service can honour a
   * degradation that happened *inside* the wrapped provider instead of relabelling it as a Jev win.
   */
  source?: "jev" | "fallback"
  /** Who produced the answer, when that is not the provider that was asked. */
  provider?: string
  /** The provider that was asked, for the audit, even when it could not answer. */
  attemptedProvider?: string
  degraded?: boolean
  degradedReason?: DegradedReason
}

export type DecisionProvider = {
  readonly id: string
  /** The raw answer, or a typed `DecisionUnavailable` when it cannot answer. */
  answer<Q extends DecisionKind>(request: DecisionRequest<Q>, signal: AbortSignal): Promise<ProviderAnswer<Q>>
}

/** A provider that could not answer, with the reason that keeps `degraded` honest. */
export class DecisionUnavailable extends Error {
  /** How long the provider asked to wait before retrying, when it said so (`Retry-After`). */
  readonly retryAfterMs?: number

  constructor(readonly reason: DegradedReason, options: { retryAfterMs?: number; message?: string } = {}) {
    super(options.message ?? reason)
    this.name = "DecisionUnavailable"
    this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * The provider that occupies the external slot when nothing is configured.
 *
 * Kept as a public seam of this phase: it makes "no external provider" a representable value rather
 * than an absent one, and it fails with the typed `provider-disabled` reason instead of pretending to
 * answer. The service does not need it — with Jev off it never reaches the external slot — so this is
 * a contract for a caller that wants the slot filled explicitly.
 */
export const nullProvider: DecisionProvider = {
  id: "null",
  async answer() {
    throw new DecisionUnavailable("provider-disabled")
  },
}
