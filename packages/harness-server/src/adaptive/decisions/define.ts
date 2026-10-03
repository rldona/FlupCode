/**
 * A decision kind as one module (PI-02).
 *
 * Everything the adaptive layer needs to know about a kind lives in its definition: what capability
 * a provider needs to answer it, how long its caller can wait, the questions its state asks, how the
 * answers read back, the deterministic baseline that answers without any provider, and what of its
 * state may leave the machine. The service, the egress guard and the config read a kind only through
 * its definition, so a new kind is a new file and an entry in the registry, not an edit to every map.
 *
 * This module imports types only, so a kind module can depend on it without pulling in the registry.
 */

import type { ContextConfig, GuardrailsConfig } from "../config"
import type { DecisionPolicy } from "../decision"
import type { Answer, Question } from "../predictive/model"

/**
 * What a provider must be able to do to answer a kind. Every kind today is a `classify` question
 * (binary gates and choices over labels); `score` and `rank` are the shapes a provider can declare
 * once a kind asks for them.
 */
export const CAPABILITIES = ["classify", "score", "rank"] as const
export type Capability = (typeof CAPABILITIES)[number]

/**
 * How long an answer may take: `hot` is a live turn bounded by the request's deadline, `warm` is
 * seconds, `batch` is background work. A kind declares the class of the path that asks it; a provider
 * declares how fast it usually answers.
 */
export const LATENCY_CLASSES = ["hot", "warm", "batch"] as const
export type LatencyClass = (typeof LATENCY_CLASSES)[number]

/**
 * What the answers mean for one kind: the typed answer, the probabilities behind it and, only when
 * the model reported one, its confidence in the chosen option. A binary `p(yes)` is not a confidence,
 * so it travels in `probabilities` and the service calibrates it.
 */
export type Reading<A> = {
  answer: A
  confidence?: number
  probabilities?: Record<string, number>
}

/** What a baseline is handed: the request's state, its policy and the clock it was built at. */
export type BaselineInput<S> = { state: S; policy: DecisionPolicy; now?: number }

/** The resolved config slices a kind's policy may carry, so its baseline and its caller agree. */
export type PolicySlices = { context: ContextConfig; guardrails: GuardrailsConfig }

export type DecisionDefinition<K extends string, S, A> = {
  kind: K
  /** What a provider must be able to do to answer it. */
  capability: Capability
  /** The class of the path that asks it; a `batch` provider is never asked a `hot` kind. */
  latencyClass: LatencyClass
  /** The readable question `explain` shows; a summary is all the audit keeps, so it is generic. */
  question: string
  /**
   * What the reading's `probabilities` map means: one `distribution` over the labels the kind can
   * answer, or independent binary `gates`, one `p(yes)` per key, which do not sum to one.
   */
  probabilities: "distribution" | "gates"
  /** The provider-neutral questions a state asks. */
  questions: (state: S) => Question[]
  /** The typed answer the answers read back to, keyed by the caller's question ids, or none. */
  read: (answers: Record<string, Answer>) => Reading<A> | undefined
  /** The deterministic answer and the rule that produced it: always there, never a model. */
  baseline: (request: BaselineInput<S>) => { answer: A; rule: string }
  /**
   * The state as it may leave the machine, before the egress guard redacts and bounds it. A field
   * that must never leave is removed or replaced here.
   */
  egress: (state: S) => unknown
  /** What the kind's policy carries beyond the common thresholds, from the resolved config. */
  policy?: (slices: PolicySlices) => Partial<DecisionPolicy>
}

/**
 * Declares a kind. The state and answer types are given explicitly, so the type checker holds every
 * part of the definition to them and rejects one that leaves a part out, the baseline included.
 */
export const defineDecision = <K extends string, S, A>(definition: DecisionDefinition<K, S, A>) => definition

// ---- reading helpers every kind shares --------------------------------------------------------

/** `p(yes)` of a binary answer; `no` is accepted when `yes` is missing, anything else is no answer. */
export const yes = (answer: Answer | undefined): number | undefined => {
  if (answer === undefined) return undefined
  if (answer.probabilities.yes !== undefined) return answer.probabilities.yes
  if (answer.probabilities.no !== undefined) return 1 - answer.probabilities.no
  return undefined
}

/** The option a `choice`/`score` answer picked: the model's own pick, else its most probable option. */
export const chosen = (answer: Answer | undefined): string | undefined => {
  if (answer === undefined) return undefined
  if (answer.choice !== undefined) return answer.choice
  const ranked = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a)
  return ranked[0]?.[0]
}

/** The weakest confidence the answers reported, when any did. */
export const weakest = (answers: ReadonlyArray<Answer | undefined>): { confidence?: number } => {
  const reported = answers.flatMap((answer) => (answer?.confidence !== undefined ? [answer.confidence] : []))
  return reported.length > 0 ? { confidence: Math.min(...reported) } : {}
}

export const isOneOf = <T extends string>(options: readonly T[], value: string | undefined): value is T =>
  value !== undefined && options.some((option) => option === value)
