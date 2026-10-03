/**
 * `completion`: is this episode, or this run task, done? Asked by the episode shadow and by the run
 * auditor (RP-06), both in the background.
 */

import { createHash } from "node:crypto"
import type { EpisodeOutcome } from "../episode"
import { defineDecision, weakest, yes } from "./define"

export type CompletionAnswer = { verdict: "complete" | "not_complete" }

export type CompletionState = {
  episodeID: string
  objective: string
  /**
   * The agent's final answer, when a run task is judged (RP-06). An episode decision has none: it is
   * asked about evidence, and the auditor of a task is asked about what the agent said it did.
   */
  answer?: string
  outcome: EpisodeOutcome
  toolCalls: number
  verifications: Array<{ step: string; ok: boolean }>
  failures: number
  projectID: string
}

export const completion = defineDecision<"completion", CompletionState, CompletionAnswer>({
  kind: "completion",
  capability: "classify",
  latencyClass: "batch",
  question: "Should this episode be marked complete?",
  probabilities: "distribution",
  questions: (state) => [
    {
      id: "verdict",
      type: "binary",
      prompt:
        state.answer === undefined
          ? `Is this episode complete? Objective: ${state.objective}`
          : `Did the agent meet this objective? Objective: ${state.objective}\nThe agent's final answer: ${state.answer}`,
    },
  ],
  read: (answers) => {
    const probability = yes(answers.verdict)
    if (probability === undefined) return undefined
    return {
      answer: { verdict: probability >= 0.5 ? "complete" : "not_complete" },
      ...weakest([answers.verdict]),
      probabilities: { complete: probability, not_complete: 1 - probability },
    }
  },
  baseline: (request) => ({ answer: deterministicCompletion(request.state), rule: "episode-outcome" }),
  // A project is named by its absolute path on the acting paths (a run's directory), which says who
  // the person is and how their disk is laid out (PI-03): the state carries a stable digest of it
  // instead, so one project still reads as one project. The request's own `projectID` keeps the path,
  // because the consent check and a local engine session need it, and it never leaves.
  egress: (state) =>
    typeof state.projectID === "string" && state.projectID !== "" ? { ...state, projectID: projectDigest(state.projectID) } : state,
})

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

const projectDigest = (projectID: string): string =>
  `project:${createHash("sha256").update(projectID).digest("hex").slice(0, 16)}`
