/**
 * The provider that always answers (FH-011).
 *
 * Deterministic first is the rule of the whole phase: every kind has a safe, reproducible answer
 * that never calls a model, so with Jev off the harness behaves exactly as it did before Jev existed.
 * Three kinds carry the rich logic this phase tests; the other four return their safe default until
 * their phase arrives.
 *
 * The seven handlers are a `Record<DecisionKind, …>`, so leaving one out is a compile error rather
 * than a runtime surprise. The generic entry point indexes that record by the request's own kind; the
 * design's §1.3 anticipated needing `request as AnyDecisionRequest` here, but `tsgo` accepts the
 * generic indexed access directly, so no cast is used and the dispatch stays sound by construction
 * (`decision.test.ts` still proves each concrete `DecisionRequest<Q>` is assignable to
 * `AnyDecisionRequest`).
 */

import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import type {
  CompletionAnswer,
  CompletionState,
  ContextItemAnswer,
  ContextItemState,
  SkillRelevanceAnswer,
  SkillRelevanceState,
} from "../decision"
import type { DecisionProvider, ProviderAnswer } from "./provider"

/** One handler per kind; the mapped type obliges every kind to be implemented. */
export type DeterministicHandler = {
  [Q in DecisionKind]: (state: DecisionSpec[Q]["state"]) => { answer: DecisionSpec[Q]["answer"]; rule: string }
}

export type DeterministicBaseline<Q extends DecisionKind = DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  rule: string
}

/**
 * Whether an episode is done, from evidence and nothing else.
 *
 * A run can be marked successful while a failure still sits in it and no verification ever ran, so a
 * success status alone is not proof. Only a success with no failures and at least one passing check
 * counts; anything else is `not_complete`, which is the safe direction — never declare victory.
 */
function deterministicCompletion(state: CompletionState): CompletionAnswer {
  const verified = state.verifications.length > 0 && state.verifications.every((verification) => verification.ok)
  const complete = state.outcome === "success" && state.failures === 0 && verified
  return { verdict: complete ? "complete" : "not_complete" }
}

const NOT_A_WORD = /[^\p{L}\p{N}]+/u
const words = (text: string): string[] =>
  text.toLowerCase().split(NOT_A_WORD).filter((word) => word.length >= 3)

/**
 * The skills whose name or description shares a word with the objective.
 *
 * Lexical and boring on purpose: it is the fallback the richer provider is measured against, and it
 * loads nothing when there is no overlap, which is exactly the behaviour the harness has today.
 */
function lexicallyRelevant(state: SkillRelevanceState): SkillRelevanceAnswer {
  const objective = new Set(words(state.objective))
  const load = state.skills
    .filter((skill) => words(`${skill.name} ${skill.description}`).some((word) => objective.has(word)))
    .map((skill) => skill.name)
  return { load }
}

/** Every item stays: the deterministic context answer never drops anything on its own. */
function deterministicContextItem(state: ContextItemState): ContextItemAnswer {
  return { decisions: state.items.map((item) => ({ id: item.id, disposition: "keep" })) }
}

export const DETERMINISTIC_HANDLERS: DeterministicHandler = {
  completion: (state) => ({ answer: deterministicCompletion(state), rule: "episode-outcome" }),
  skillRelevance: (state) => ({ answer: lexicallyRelevant(state), rule: "lexical-objective-match" }),
  contextItem: (state) => ({ answer: deterministicContextItem(state), rule: "keep-all" }),
  // The four kinds below are typed but not implemented in this phase: each answers its safe default.
  modelRoute: () => ({ answer: { tier: "BALANCED" }, rule: "declared-policy" }),
  agentRoute: () => ({ answer: { agent: "CONTINUE" }, rule: "safe-default" }),
  toolRisk: () => ({ answer: { risk: "ALLOW" }, rule: "permission-floor" }),
  failure: () => ({ answer: { verdict: "continue" }, rule: "safe-default" }),
}

/** The deterministic answer and the rule that produced it, for the service to store as the baseline. */
export function deterministicBaseline<Q extends DecisionKind>(request: DecisionRequest<Q>): DeterministicBaseline<Q> {
  const handler: DeterministicHandler[Q] = DETERMINISTIC_HANDLERS[request.kind]
  return handler(request.state)
}

/** The provider the service always has, whatever the external slot holds. */
export function createDeterministicProvider(now: () => number = Date.now): DecisionProvider {
  return {
    id: "deterministic",
    async answer<Q extends DecisionKind>(request: DecisionRequest<Q>): Promise<ProviderAnswer<Q>> {
      const startedAt = now()
      const { answer } = deterministicBaseline(request)
      return { answer, latencyMs: now() - startedAt }
    },
  }
}
