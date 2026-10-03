/**
 * The neutral predictive-model contract (AH-C01).
 *
 * A predictive model is an optional advisor behind the deterministic baseline: it is handed neutral
 * questions about a redacted state and answers each with a probability distribution. It owns its
 * own wire encoding — a remote model serializes the body it sends, a local one needs none — and it
 * never sees a typed `DecisionRequest`, a threshold or the audit. The decision service plans the
 * questions per kind (`../questions`), reads the typed answer back from the distributions, derives
 * confidence itself (`max_k p_k`, never a model's claim alone) and keeps governance: breaker, budget,
 * single-flight and deadline.
 *
 * A model that cannot answer throws a typed `DecisionUnavailable` (`../providers/provider`), and the
 * service degrades to the baseline with that reason.
 */

import type { KeySlot } from "../model-key"

/**
 * A question as every model sees it.
 *
 * `binary` is answered with `{ yes, no }`; `choice` with a distribution over `options`; `score` with a
 * distribution over `options`, which are ordered from lowest to highest so a model that answers with
 * a number can map it onto a label. The `id` is opaque and positional (the egress guard assigns it),
 * so no caller identifier — a file path, a skill name — reaches a model through it.
 */
export type Question =
  | { id: string; type: "binary"; prompt: string }
  | { id: string; type: "choice"; prompt: string; options: string[] }
  | { id: string; type: "score"; prompt: string; options: string[] }

export type QuestionType = Question["type"]

/** One question's answer. */
export type Answer = {
  /**
   * Always a distribution: `{ yes, no }` for a binary question, the question's options otherwise. A
   * model may report only part of the options; the service reads what is there and never guesses.
   */
  probabilities: Record<string, number>
  /** The option the model chose, for `choice` and `score`; absent means the most probable option. */
  choice?: string
  /**
   * The model's own confidence in its chosen option, when it reports one. It is only ever an extra
   * axis: the service records the weakest of this and the chosen answer's probability.
   */
  confidence?: number
}

export type Prediction = {
  /** Keyed by question id; a question the model did not answer is absent, never defaulted. */
  answers: Record<string, Answer>
  /** The model's own time to answer, transport included. */
  latencyMs: number
  /** What the call consumed. A model that is not told its usage reports its best estimate. */
  usage: { inputTokens: number; costUsd: number }
  /** Who answered: the model id and, when the model reports one, its version. */
  model: { id: string; version?: string }
}

/**
 * The state a model is handed: the guard's redacted, bounded serialization of the request's state,
 * never the raw object. `kind` and `projectID` travel so a remote model can re-check its egress
 * allowlist before sending a byte.
 */
export type PredictionState = {
  kind: string
  projectID?: string
  text: string
}

export type PredictOptions = {
  /** The per-attempt budget in milliseconds; the service also bounds a hot call end to end. */
  deadlineMs: number
  signal: AbortSignal
  /** `hot` is a live turn: a single attempt, never sleeping on a `Retry-After`. */
  mode: "hot" | "batch"
  /** Reserves budget for one more attempt before a retry; `false` means stop. Only a retrying model calls it. */
  retry?: () => boolean
}

export type PredictiveModel = {
  /** The registry id `adaptive.models.<kind>` names, and the audit's `provider`. */
  readonly id: string
  /** A `remote` model is only asked for kinds and projects the egress guard allows. */
  readonly locality: "local" | "remote"
  /**
   * The name a reader is shown for it ("Small model (through the engine)"); the id is only what the
   * config file says. The settings view serves it with the registry so no client spells it.
   */
  readonly name?: string
  /** Whether it needs an API key (ADR-0017, amended) before it can answer. */
  readonly needsKey?: boolean
  /** Where that key lives, read live from its settings: set exactly when `needsKey` is (PI-01). */
  readonly keySlot?: () => KeySlot
  /** The kinds it can answer; a kind assigned to a model that does not support it keeps the baseline. */
  readonly supports: readonly string[]
  predict(state: PredictionState, questions: readonly Question[], options: PredictOptions): Promise<Prediction>
}
