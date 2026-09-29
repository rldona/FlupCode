/**
 * The Jev wire format, parsed into plain TypeScript (FH-012).
 *
 * Jev answers three kinds of question — `noul` (a single 0..1 probability), `choice` (one option
 * with its distribution and a confidence) and `score` (a score with its legend and a confidence) —
 * and returns them keyed by question id, never in the order they were sent. This module owns the
 * shape of that exchange and the defensive reading of it; no other module parses a Jev body.
 *
 * The wire id is `w{index}` and the caller's id is `question.id`; `parseJevResponse` maps the
 * former back to the latter, which is what lets answers arrive shuffled and still land correctly.
 */

import { assembleById } from "./assembly"
import { QUESTION_TYPES, wireID, wireQuestions } from "../questions"
import type { Question, QuestionType } from "../questions"

export const JEV_QUESTION_TYPES = QUESTION_TYPES
export type JevQuestionType = QuestionType

/** The caller's question shape; the plan that builds it lives in `../questions`. */
export type JevQuestion = Question

export type JevNoulAnswer = { type: "noul"; probability: number }
export type JevChoiceAnswer = {
  type: "choice"
  choice: string
  probabilities: Record<string, number>
  confidence?: number
}
export type JevScoreAnswer = {
  type: "score"
  score: number
  legend: string[]
  probabilities: Record<string, number>
  confidence?: number
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

export type JevPrediction = {
  modelVersion?: string
  /** Keyed by the caller's question id; an answer Jev did not send is absent, not guessed. */
  answers: Record<string, JevAnswer>
}

export type JevWireQuestion = {
  id: string
  type: JevQuestionType
  prompt: string
  choices?: string[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1

const isConfidence = (value: unknown): value is number => isProbability(value)

const numberMap = (value: unknown): Record<string, number> => {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "number" && Number.isFinite(entry) ? [[key, entry] as const] : [],
    ),
  )
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const parseNoul = (value: unknown): JevNoulAnswer | undefined =>
  isPlainObject(value) && isProbability(value.probability) ? { type: "noul", probability: value.probability } : undefined

const parseChoice = (value: unknown): JevChoiceAnswer | undefined => {
  if (!isPlainObject(value) || typeof value.choice !== "string") return undefined
  return {
    type: "choice",
    choice: value.choice,
    probabilities: numberMap(value.probabilities),
    ...(isConfidence(value.confidence) ? { confidence: value.confidence } : {}),
  }
}

const parseScore = (value: unknown): JevScoreAnswer | undefined => {
  if (!isPlainObject(value) || typeof value.score !== "number" || !Number.isFinite(value.score)) return undefined
  return {
    type: "score",
    score: value.score,
    legend: stringList(value.legend),
    probabilities: numberMap(value.probabilities),
    ...(isConfidence(value.confidence) ? { confidence: value.confidence } : {}),
  }
}

const PARSERS: Record<JevQuestionType, (value: unknown) => JevAnswer | undefined> = {
  noul: parseNoul,
  choice: parseChoice,
  score: parseScore,
}

/** Re-exported so callers keep importing the wire format from this module's contract. */
export { wireID, wireQuestions } from "../questions"

/**
 * Reads an answer body by question id.
 *
 * The type is taken from what was asked, not from what came back: a provider that mislabels an
 * answer cannot turn a `noul` into a `choice`. A question whose answer is missing or malformed is
 * simply absent from the result, so the caller can tell "not sent" from "sent as a default".
 */
export function parseJevResponse(payload: unknown, questions: readonly JevQuestion[]): JevPrediction {
  const envelope = isPlainObject(payload) ? payload : {}
  const modelVersion = typeof envelope.model === "string" ? envelope.model : undefined
  const source = isPlainObject(envelope.answers) ? envelope.answers : isPlainObject(envelope.results) ? envelope.results : {}

  const parsed = new Map<string, JevAnswer>()
  questions.forEach((question, index) => {
    const answer = PARSERS[question.type](source[wireID(index)])
    if (answer) parsed.set(question.id, answer)
  })
  // Assembly by id: the answer that came back under `w{index}` is placed on its question, in order.
  return { modelVersion, answers: Object.fromEntries(assembleById(questions.map((question) => question.id), parsed)) }
}
