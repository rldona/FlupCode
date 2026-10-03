/**
 * The deterministic baseline: the answer that is always there (FH-011).
 *
 * Deterministic first is the rule of the whole phase: every kind has a safe, reproducible answer
 * that never calls a model, so with no model the harness behaves exactly as it did before models existed.
 * `skillReflection` answers the inert `no-reflection`, so without a model no lesson is ever learned.
 *
 * Each kind declares its baseline in its own module (PI-02) and `defineDecision` requires one, so a
 * kind without a baseline does not compile. This is the entry point for the built-in kinds.
 */

import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { DECISIONS } from "../decisions/registry"

export type DeterministicBaseline<Q extends DecisionKind = DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  rule: string
}

/** The deterministic answer and the rule that produced it, for the service to store as the baseline. */
export function deterministicBaseline<Q extends DecisionKind>(request: DecisionRequest<Q>): DeterministicBaseline<Q> {
  return DECISIONS.get(request.kind).baseline(request)
}
