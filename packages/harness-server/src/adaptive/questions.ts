/**
 * The questions a decision asks, and their wire encoding (FH-012/FH-014).
 *
 * The plan lives here, provider-neutral, because two callers need the same question set: the Jev
 * adapter asks them, and `EgressGuard.prepare` serializes and redacts their prompts as part of the
 * outbound body. One planner is what keeps the body the guard writes and the answers the adapter
 * parses keyed to the same ids, so a prompt built from raw state cannot bypass the guard.
 */

import { AGENT_ROUTES, DECISION_TIERS, ITEM_DISPOSITIONS, REFLECTION_INTENTS, TOOL_RISKS } from "./decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "./decision"

export const QUESTION_TYPES = ["noul", "choice", "score"] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export type Question = {
  /** The caller's id; the wire id is derived from the question's position. */
  id: string
  type: QuestionType
  prompt: string
  /** `choice` and `score` need advertised options; `noul` does not. */
  choices?: string[]
}

/** A question as it travels: the caller's id is replaced by its position (`w{index}`). */
export type WireQuestion = { id: string; type: QuestionType; prompt: string; choices?: string[] }

/** The questions one state asks, one plan per kind so adding a kind does not compile until it is asked. */
type QuestionPlanner = {
  [Q in DecisionKind]: (state: DecisionSpec[Q]["state"]) => Question[]
}

const questionPlans: QuestionPlanner = {
  completion: (state) => [
    { id: "verdict", type: "noul", prompt: `Is this episode complete? Objective: ${state.objective}` },
  ],
  // A gate per candidate skill: the answer is the set of names above the gate, which the service
  // then thresholds again. A state with no candidates asks nothing.
  skillRelevance: (state) =>
    state.skills.map((skill) => ({
      id: skill.name,
      type: "noul",
      prompt: `Load the "${skill.name}" skill (${skill.description}) for: ${state.objective}?`,
    })),
  contextItem: (state) =>
    state.items.map((item) => ({
      id: item.id,
      type: "choice",
      prompt: `Disposition for the ${item.kind} item "${item.id}" against: ${state.objective}`,
      choices: [...ITEM_DISPOSITIONS],
    })),
  modelRoute: (state) => [
    {
      id: "tier",
      type: "choice",
      prompt: `Which tier for the ${state.role} role on "${state.taskName}"?`,
      choices: [...DECISION_TIERS],
    },
  ],
  agentRoute: (state) => [
    { id: "agent", type: "choice", prompt: `Which route for: ${state.objective}?`, choices: [...AGENT_ROUTES] },
  ],
  toolRisk: (state) => [
    { id: "risk", type: "score", prompt: `How risky is calling ${state.tool}?`, choices: [...TOOL_RISKS] },
  ],
  failure: (state) => [
    {
      id: "verdict",
      type: "noul",
      prompt: `Should the harness intervene? repeatedErrors=${state.repeatedErrors}, stepsUsed=${state.stepsUsed}`,
    },
  ],
  // One request per episode: `reusable` is the gate, `intent` is what the lesson calls for, and
  // `target` is only asked when there is a roster to point at (a state with no skills asks two).
  skillReflection: (state) => [
    {
      id: "reusable",
      type: "noul",
      prompt: `Does this episode contain a reusable, non-obvious lesson for a future task? Objective: ${state.objective}. Signals: ${state.signals.join("; ")}`,
    },
    {
      id: "intent",
      type: "choice",
      prompt: "Which change does the lesson call for?",
      choices: [...REFLECTION_INTENTS],
    },
    ...(state.skills.length > 0
      ? [
          {
            id: "target",
            type: "choice" as const,
            prompt: "Which existing skill should it target, if any?",
            choices: state.skills.map((skill) => skill.name).slice(0, 255),
          },
        ]
      : []),
  ],
}

/** The questions a request asks, from its kind and state; the one planner both callers share. */
export function questionsFor<Q extends DecisionKind>(request: DecisionRequest<Q>): Question[] {
  return questionPlans[request.kind](request.state)
}

/** The `w{index}` wire id of each question, in the order they are sent. */
export const wireID = (index: number): string => `w${index}`

export function wireQuestions(questions: readonly Question[]): WireQuestion[] {
  return questions.map((question, index) => ({
    id: wireID(index),
    type: question.type,
    prompt: question.prompt,
    ...(question.choices ? { choices: question.choices } : {}),
  }))
}
