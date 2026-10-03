/**
 * The questions a decision asks, and how their answers read back (FH-012/FH-014, AH-C01).
 *
 * Both halves are provider-neutral and live together so they stay keyed to the same ids: the plan
 * turns a typed state into `binary`/`choice`/`score` questions, and the reader turns the model's
 * distributions back into the kind's typed answer. No model encodes or decodes a kind: a model only
 * sees neutral questions, and its wire format is its own business (each provider module owns its own).
 *
 * `EgressGuard.prepare` redacts the planned prompts and replaces every caller id with a positional
 * one before any model sees them; `readAnswers` maps the answers back by position.
 */

import type { DecisionKind, DecisionRequest, DecisionSpec } from "./decision"
import type { Answer, Question } from "./predictive/model"
import { completion } from "./decisions/completion"
import { skillRelevance } from "./decisions/skill-relevance"
import { contextItem } from "./decisions/context-item"
import { failure } from "./decisions/failure"
import { skillReflection } from "./decisions/skill-reflection"

/** The questions one state asks, one plan per kind so adding a kind does not compile until it is asked. */
type QuestionPlanner = {
  [Q in DecisionKind]: (state: DecisionSpec[Q]["state"]) => Question[]
}

const questionPlans: QuestionPlanner = {
  completion: completion.questions,
  skillRelevance: skillRelevance.questions,
  contextItem: contextItem.questions,
  failure: failure.questions,
  skillReflection: skillReflection.questions,
}

/** The questions a request asks, from its kind and state; the one planner every caller shares. */
export function questionsFor<Q extends DecisionKind>(request: DecisionRequest<Q>): Question[] {
  return questionPlans[request.kind](request.state)
}

/** The opaque id the egress guard gives the question at `index`, so no caller id leaves with it. */
export const questionID = (index: number): string => `q${index}`

// ---- reading an answer back ------------------------------------------------------------------

/**
 * What the answers mean for one kind: the typed answer, the probabilities behind it and, only when
 * the model reported one, its confidence in the chosen option. A binary `p(yes)` is not a confidence,
 * so it travels in `probabilities` and the service calibrates it (`chosenProbability`).
 */
export type Reading<Q extends DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  confidence?: number
  probabilities?: Record<string, number>
}

type AnswerReader = {
  [Q in DecisionKind]: (answers: Record<string, Answer>) => Reading<Q> | undefined
}

const answerReaders: AnswerReader = {
  completion: completion.read,
  skillRelevance: skillRelevance.read,
  contextItem: contextItem.read,
  failure: failure.read,
  skillReflection: skillReflection.read,
}

/**
 * The typed answer a request's questions read back to, or `undefined` when the answers do not make
 * one (the service degrades that as `malformed`).
 *
 * `answers` is keyed by the opaque ids the guard handed the model (`questionID`); they are mapped back
 * to the caller's ids by position, in the order the questions were asked.
 */
export function readAnswers<Q extends DecisionKind>(
  kind: Q,
  questions: readonly Question[],
  answers: Record<string, Answer>,
): Reading<Q> | undefined {
  const byCaller = Object.fromEntries(
    questions.flatMap((question, index) => {
      const answer = answers[questionID(index)]
      return answer ? [[question.id, answer] as const] : []
    }),
  )
  const reader: AnswerReader[Q] = answerReaders[kind]
  return reader(byCaller)
}
