/**
 * The questions a decision asks, and how their answers read back (FH-012/FH-014, AH-C01).
 *
 * Both halves are provider-neutral and live together so they stay keyed to the same ids: the plan
 * turns a typed state into `binary`/`choice`/`score` questions, and the reader turns the model's
 * distributions back into the kind's typed answer. No model encodes or decodes a kind: a model only
 * sees neutral questions, and its wire format is its own business (`providers/jev.ts` owns Jev's).
 *
 * `EgressGuard.prepare` redacts the planned prompts and replaces every caller id with a positional
 * one before any model sees them; `readAnswers` maps the answers back by position.
 */

import {
  AGENT_ROUTES,
  DECISION_TIERS,
  ITEM_DISPOSITIONS,
  REFLECTION_INTENTS,
  TOOL_RISKS,
  isReflectionIntent,
} from "./decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "./decision"
import { clampLearned } from "./risk"
import type { Answer, Question } from "./predictive/model"

/** The questions one state asks, one plan per kind so adding a kind does not compile until it is asked. */
type QuestionPlanner = {
  [Q in DecisionKind]: (state: DecisionSpec[Q]["state"]) => Question[]
}

const questionPlans: QuestionPlanner = {
  completion: (state) => [
    { id: "verdict", type: "binary", prompt: `Is this episode complete? Objective: ${state.objective}` },
  ],
  // A gate per candidate skill: the answer is the set of names above the gate, which the service
  // then thresholds again. A state with no candidates asks nothing.
  skillRelevance: (state) =>
    state.skills.map((skill) => ({
      id: skill.name,
      type: "binary",
      prompt: `Load the "${skill.name}" skill (${skill.description}) for: ${state.objective}?`,
    })),
  contextItem: (state) =>
    state.items.map((item) => ({
      id: item.id,
      type: "choice",
      prompt: `Disposition for the ${item.kind} item "${item.id}" against: ${state.objective}`,
      options: [...ITEM_DISPOSITIONS],
    })),
  modelRoute: (state) => [
    {
      id: "tier",
      type: "choice",
      prompt: `Which tier for the ${state.role} role on "${state.taskName}"?`,
      options: [...DECISION_TIERS],
    },
  ],
  agentRoute: (state) => [
    { id: "agent", type: "choice", prompt: `Which route for: ${state.objective}?`, options: [...AGENT_ROUTES] },
  ],
  toolRisk: (state) => [
    { id: "risk", type: "score", prompt: `How risky is calling ${state.tool}?`, options: [...TOOL_RISKS] },
  ],
  failure: (state) => [
    {
      id: "verdict",
      type: "binary",
      prompt: `Should the harness intervene? repeatedErrors=${state.repeatedErrors}, stepsUsed=${state.stepsUsed}`,
    },
  ],
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

/** `p(yes)` of a binary answer; `no` is accepted when `yes` is missing, anything else is no answer. */
const yes = (answer: Answer | undefined): number | undefined => {
  if (answer === undefined) return undefined
  if (answer.probabilities.yes !== undefined) return answer.probabilities.yes
  if (answer.probabilities.no !== undefined) return 1 - answer.probabilities.no
  return undefined
}

/** The option a `choice`/`score` answer picked: the model's own pick, else its most probable option. */
const chosen = (answer: Answer | undefined): string | undefined => {
  if (answer === undefined) return undefined
  if (answer.choice !== undefined) return answer.choice
  const ranked = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a)
  return ranked[0]?.[0]
}

/** The weakest confidence the answers reported, when any did. */
const weakest = (answers: ReadonlyArray<Answer | undefined>): { confidence?: number } => {
  const reported = answers.flatMap((answer) => (answer?.confidence !== undefined ? [answer.confidence] : []))
  return reported.length > 0 ? { confidence: Math.min(...reported) } : {}
}

const isOneOf = <T extends string>(options: readonly T[], value: string | undefined): value is T =>
  value !== undefined && options.some((option) => option === value)

const answerReaders: AnswerReader = {
  completion: (answers) => {
    const probability = yes(answers.verdict)
    if (probability === undefined) return undefined
    return {
      answer: { verdict: probability >= 0.5 ? "complete" : "not_complete" },
      ...weakest([answers.verdict]),
      probabilities: { complete: probability, not_complete: 1 - probability },
    }
  },
  skillRelevance: (answers) => {
    const gates = Object.entries(answers).flatMap(([name, answer]) => {
      const probability = yes(answer)
      return probability === undefined ? [] : [[name, probability] as const]
    })
    return {
      answer: { load: gates.filter(([, probability]) => probability >= 0.5).map(([name]) => name) },
      ...weakest(Object.values(answers)),
      probabilities: Object.fromEntries(gates),
    }
  },
  // An item whose confidence was not reported counts as zero: the weakest item sets the confidence,
  // and an unreported one must not read as certain.
  contextItem: (answers) => {
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
  modelRoute: (answers) => {
    const tier = chosen(answers.tier)
    if (!answers.tier || !isOneOf(DECISION_TIERS, tier)) return undefined
    return { answer: { tier }, confidence: answers.tier.confidence, probabilities: answers.tier.probabilities }
  },
  agentRoute: (answers) => {
    const agent = chosen(answers.agent)
    if (!answers.agent || !isOneOf(AGENT_ROUTES, agent)) return undefined
    return { answer: { agent }, confidence: answers.agent.confidence, probabilities: answers.agent.probabilities }
  },
  // A learned score may only raise confirmation, never exceed the ceiling (FH-063, ADR-0023 §5).
  toolRisk: (answers) => {
    const risk = chosen(answers.risk)
    if (!answers.risk || !isOneOf(TOOL_RISKS, risk)) return undefined
    return {
      answer: { risk: clampLearned(risk) },
      confidence: answers.risk.confidence,
      probabilities: answers.risk.probabilities,
    }
  },
  failure: (answers) => {
    const probability = yes(answers.verdict)
    if (probability === undefined) return undefined
    return {
      answer: { verdict: probability >= 0.5 ? "intervene" : "continue" },
      ...weakest([answers.verdict]),
      probabilities: { continue: 1 - probability, intervene: probability },
    }
  },
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
