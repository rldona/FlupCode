/**
 * `failure`: should the harness intervene in this loop? Asked live by the loop guardrails when a
 * session repeats a call or an error (FH-060/061, ADR-0023 §6).
 */

import { defineDecision, weakest, yes } from "./define"

export type FailureAnswer = { verdict: "continue" | "intervene" }

export type FailureState = {
  repeatedCalls: number
  repeatedErrors: number
  stepsUsed: number
  stepsBudget?: number
}

export const failure = defineDecision<"failure", FailureState, FailureAnswer>({
  kind: "failure",
  capability: "classify",
  latencyClass: "hot",
  question: "Should the harness intervene in this loop?",
  probabilities: "distribution",
  questions: (state) => [
    {
      id: "verdict",
      type: "binary",
      prompt: `Should the harness intervene? repeatedErrors=${state.repeatedErrors}, stepsUsed=${state.stepsUsed}`,
    },
  ],
  read: (answers) => {
    const probability = yes(answers.verdict)
    if (probability === undefined) return undefined
    return {
      answer: { verdict: probability >= 0.5 ? "intervene" : "continue" },
      ...weakest([answers.verdict]),
      probabilities: { continue: 1 - probability, intervene: probability },
    }
  },
  // A repeated identical call or error is an intervention; anything below the policy threshold is a
  // plain continue. Calls are checked first, mirroring the run that ends the observation ring
  // (FH-060/061, ADR-0023 §6).
  baseline: (request) => {
    const repeatedCalls = request.state.repeatedCalls
    const repeatedErrors = request.state.repeatedErrors
    if (repeatedCalls >= (request.policy.repeatedCalls ?? 3)) {
      return { answer: { verdict: "intervene" }, rule: "repeated-calls" }
    }
    if (repeatedErrors >= (request.policy.repeatedErrors ?? 3)) {
      return { answer: { verdict: "intervene" }, rule: "repeated-errors" }
    }
    return { answer: { verdict: "continue" }, rule: "safe-default" }
  },
  egress: (state) => state,
  // The failure thresholds are the guardrails slice, so the detector and its decision policy agree.
  policy: (slices) => ({
    repeatedCalls: slices.guardrails.repeatedCalls,
    repeatedErrors: slices.guardrails.repeatedErrors,
  }),
})
