/**
 * `modelRoute`: should the next task of a run move to its policy's fallback model? Asked by the runner
 * before each agent task of a run whose policy names a fallback, when there is a budget or a quota
 * reading to decide on (PI-04). The task waits on it, so it is a `hot` kind, bounded by its timeout.
 */

import { defineDecision, weakest, yes } from "./define"

export type ModelRouteAnswer = { route: "keep" | "fallback" }

/** How far into a limit a run is: a share from 0 to 1 of what it may use. */
export type ModelRouteState = {
  /** The role the task runs as, when it names one. */
  role?: string
  /** The model the task would run on, as "provider/model"; absent means the engine's default. */
  model?: string
  fallback: string
  /** The share of a budget or a quota window at which the run moves to the fallback. */
  threshold: number
  /** The budget that covers the run and is furthest spent, on the usage ledger (UL-08). */
  budget?: { scope: "run" | "day" | "workflow" | "routine"; unit: "usd" | "tokens"; share: number }
  /** The shortest quota window of the model's provider, as last read (UL-07). It covers the whole key. */
  quota?: { providerID: string; window: string; share: number }
}

export const modelRoute = defineDecision<"modelRoute", ModelRouteState, ModelRouteAnswer>({
  kind: "modelRoute",
  capability: "classify",
  latencyClass: "hot",
  question: "Should the next task move to the fallback model?",
  probabilities: "distribution",
  questions: (state) => [
    {
      id: "route",
      type: "binary",
      prompt: [
        `Should the next task of this run move from ${state.model ?? "the default model"} to the cheaper fallback ${state.fallback}?`,
        state.budget ? `Budget spent: ${percent(state.budget.share)} (${state.budget.unit}).` : undefined,
        state.quota ? `Provider quota window used: ${percent(state.quota.share)}.` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    },
  ],
  read: (answers) => {
    const probability = yes(answers.route)
    if (probability === undefined) return undefined
    return {
      answer: { route: probability >= 0.5 ? "fallback" : "keep" },
      ...weakest([answers.route]),
      probabilities: { keep: 1 - probability, fallback: probability },
    }
  },
  // The budget first: it is the run's own limit, and the ledger is what the gate stops at. A quota
  // reading is the provider's, for the whole key.
  baseline: (request) => {
    const state = request.state
    if (state.budget && state.budget.share >= state.threshold) return { answer: { route: "fallback" }, rule: "budget-share" }
    if (state.quota && state.quota.share >= state.threshold) return { answer: { route: "fallback" }, rule: "quota-share" }
    return { answer: { route: "keep" }, rule: "under-threshold" }
  },
  // Model keys, a role and shares: nothing here names a project, a person or a folder, and the egress
  // guard sweeps the strings for secrets as it does for every kind. Built field by field, so a field
  // added to the state later does not leave the machine without being listed here.
  egress: (state) => ({
    ...(state.role !== undefined ? { role: state.role } : {}),
    ...(state.model !== undefined ? { model: state.model } : {}),
    fallback: state.fallback,
    threshold: state.threshold,
    ...(state.budget ? { budget: { scope: state.budget.scope, unit: state.budget.unit, share: state.budget.share } } : {}),
    ...(state.quota ? { quota: { providerID: state.quota.providerID, window: state.quota.window, share: state.quota.share } } : {}),
  }),
})

const percent = (share: number) => `${Math.round(share * 100)}%`
