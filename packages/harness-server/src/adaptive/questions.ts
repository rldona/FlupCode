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

import { REFLECTION_INTENTS, isReflectionIntent } from "./decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "./decision"
import type { Answer, Question } from "./predictive/model"
import { completion } from "./decisions/completion"
import { skillRelevance } from "./decisions/skill-relevance"
import { contextItem } from "./decisions/context-item"
import { failure } from "./decisions/failure"
import { chosen, isOneOf, weakest, yes } from "./decisions/define"

/** The questions one state asks, one plan per kind so adding a kind does not compile until it is asked. */
type QuestionPlanner = {
  [Q in DecisionKind]: (state: DecisionSpec[Q]["state"]) => Question[]
}

const questionPlans: QuestionPlanner = {
  completion: completion.questions,
  skillRelevance: skillRelevance.questions,
  contextItem: contextItem.questions,
  failure: failure.questions,
  // One request per episode: `reusable` is the gate, `intent` is what the lesson calls for, and
  // `target` is only asked when there is a roster to point at (a state with no skills asks two).
  skillReflection: (state) => [
    {
      id: "reusable",
      type: "binary",
      prompt: `Does this episode contain a reusable, non-obvious lesson for a future task? Objective: ${state.objective}. Signals: ${state.signals.join("; ")}`,
    },
    {
      id: "intent",
      type: "choice",
      prompt: "Which change does the lesson call for?",
      options: [...REFLECTION_INTENTS],
    },
    ...(state.skills.length > 0
      ? [
          {
            id: "target",
            type: "choice" as const,
            prompt: "Which existing skill should it target, if any?",
            options: state.skills.map((skill) => skill.name).slice(0, 255),
          },
        ]
      : []),
  ],
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
  // The binary gate decides reusable; a missing or unrecognised intent falls to the safe `add`, and
  // the target is only carried when the model named one. The service folds the gate's certainty into
  // the reported confidence and keeps the weakest, so a noisy intent can pull a confident gate below
  // the policy and the service degrades to inert.
  skillReflection: (answers) => {
    const reusable = yes(answers.reusable)
    if (reusable === undefined) return undefined
    const intent = chosen(answers.intent)
    const target = chosen(answers.target)
    return {
      answer: {
        reusable: reusable >= 0.5,
        intent: isReflectionIntent(intent) ? intent : "add",
        ...(target ? { target } : {}),
      },
      ...weakest([answers.reusable, answers.intent]),
      probabilities: { reusable },
    }
  },
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
