/**
 * The deterministic baseline: the answer that is always there (FH-011).
 *
 * Deterministic first is the rule of the whole phase: every kind has a safe, reproducible answer
 * that never calls a model, so with no model the harness behaves exactly as it did before models existed.
 * Three kinds carry the rich logic this phase tests; the others return their safe default until
 * their phase arrives — `skillReflection` answers the inert `no-reflection`, so without a model no
 * lesson is ever learned.
 *
 * The handlers are a `Record<DecisionKind, …>`, so leaving one out is a compile error rather
 * than a runtime surprise. The generic entry point indexes that record by the request's own kind; the
 * design's §1.3 anticipated needing `request as AnyDecisionRequest` here, but `tsgo` accepts the
 * generic indexed access directly, so no cast is used and the dispatch stays sound by construction
 * (`decision.test.ts` still proves each concrete `DecisionRequest<Q>` is assignable to
 * `AnyDecisionRequest`).
 */

import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { completion } from "../decisions/completion"
import { skillRelevance } from "../decisions/skill-relevance"
import { contextItem } from "../decisions/context-item"
import { failure } from "../decisions/failure"

/** One handler per kind; the mapped type obliges every kind to be implemented. */
export type DeterministicHandler = {
  [Q in DecisionKind]: (request: DecisionRequest<Q>) => {
    answer: DecisionSpec[Q]["answer"]
    rule: string
  }
}

export type DeterministicBaseline<Q extends DecisionKind = DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  rule: string
}

export const DETERMINISTIC_HANDLERS: DeterministicHandler = {
  completion: completion.baseline,
  skillRelevance: skillRelevance.baseline,
  contextItem: contextItem.baseline,
  failure: failure.baseline,
  // Inert on purpose: without a classifier nothing is reusable, so an idle project learns nothing.
  skillReflection: () => ({ answer: { reusable: false, intent: "add" }, rule: "no-reflection" }),
}

/** The deterministic answer and the rule that produced it, for the service to store as the baseline. */
export function deterministicBaseline<Q extends DecisionKind>(request: DecisionRequest<Q>): DeterministicBaseline<Q> {
  const handler: DeterministicHandler[Q] = DETERMINISTIC_HANDLERS[request.kind]
  return handler(request)
}
