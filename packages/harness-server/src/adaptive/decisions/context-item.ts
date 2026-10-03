/**
 * `contextItem`: what should happen to each item of a run prompt's context? Asked by the context
 * manager about the items in the scorer's ambiguous band, on the live path and in the shadow.
 */

import type { ContextItem } from "../context-items"
import { deterministicContextItem } from "../scoring"
import { chosen, defineDecision, isOneOf } from "./define"

export const ITEM_DISPOSITIONS = ["keep", "archive", "drop"] as const
export type ItemDisposition = (typeof ITEM_DISPOSITIONS)[number]

export type ContextItemAnswer = { decisions: Array<{ id: string; disposition: ItemDisposition }> }

export type ContextItemState = { objective: string; items: ContextItem[] }

export const contextItem = defineDecision<"contextItem", ContextItemState, ContextItemAnswer>({
  kind: "contextItem",
  capability: "classify",
  latencyClass: "hot",
  question: "What disposition should each context item take?",
  probabilities: "distribution",
  questions: (state) =>
    state.items.map((item) => ({
      id: item.id,
      type: "choice",
      prompt: `Disposition for the ${item.kind} item "${item.id}" against: ${state.objective}`,
      options: [...ITEM_DISPOSITIONS],
    })),
  // An item whose confidence was not reported counts as zero: the weakest item sets the confidence,
  // and an unreported one must not read as certain.
  read: (answers) => {
    const decisions = Object.entries(answers).flatMap(([id, answer]) => {
      const disposition = chosen(answer)
      return isOneOf(ITEM_DISPOSITIONS, disposition) ? [{ id, disposition, confidence: answer.confidence ?? 0 }] : []
    })
    if (decisions.length === 0) return { answer: { decisions: [] } }
    return {
      answer: { decisions: decisions.map((decision) => ({ id: decision.id, disposition: decision.disposition })) },
      confidence: Math.min(...decisions.map((decision) => decision.confidence)),
    }
  },
  // The scorer replaced Phase 2's keep-all: the single implementation lives in `scoring.ts`. The
  // request's clock and the resolved thresholds on its policy are forwarded, so a manager-computed
  // plan and this baseline score on the same clock and the same numbers.
  baseline: (request) => ({
    answer: deterministicContextItem(
      request.state,
      request.now,
      request.policy.keepThreshold,
      request.policy.dropThreshold,
    ),
    rule: "context-score",
  }),
  egress: (state) => state,
  // The policy carries the resolved scorer thresholds, so the decision baseline and the manager's plan
  // are scored against one source instead of two defaults.
  policy: (slices) => ({
    keepThreshold: slices.context.keepThreshold,
    dropThreshold: slices.context.dropThreshold,
  }),
})
