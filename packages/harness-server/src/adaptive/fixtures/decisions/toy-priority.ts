/**
 * A toy decision kind, for the PI-02 acceptance test: everything a new kind needs, in one file, with
 * no edit to any existing map. It is registered by the test, never by the server.
 */

import { defineDecision, weakest, yes } from "../../decisions/define"

export type PriorityState = { title: string; labels: string[]; reporter: string }
export type PriorityAnswer = { level: "low" | "high" }

export const priority = defineDecision<"priority", PriorityState, PriorityAnswer>({
  kind: "priority",
  capability: "classify",
  latencyClass: "warm",
  question: "Is this issue high priority?",
  probabilities: "distribution",
  questions: (state) => [{ id: "high", type: "binary", prompt: `Is "${state.title}" high priority?` }],
  read: (answers) => {
    const probability = yes(answers.high)
    if (probability === undefined) return undefined
    return {
      answer: { level: probability >= 0.5 ? "high" : "low" },
      ...weakest([answers.high]),
      probabilities: { high: probability, low: 1 - probability },
    }
  },
  baseline: (request) => ({
    answer: { level: request.state.labels.includes("urgent") ? "high" : "low" },
    rule: "urgent-label",
  }),
  // Who reported it never leaves the machine.
  egress: (state) => ({ title: state.title, labels: state.labels }),
})
