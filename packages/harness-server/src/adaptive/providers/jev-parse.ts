/**
 * The Jev wire format: encoding neutral questions and parsing the answers (FH-012, AH-C01).
 *
 * Jev answers three kinds of question — `noul` (a single 0..1 probability), `choice` (one option
 * with its distribution and a confidence) and `score` (a score with its legend and a confidence) —
 * and returns them keyed by question id, never in the order they were sent. This module owns the
 * shape of that exchange and the defensive reading of it; no other module encodes or parses a Jev
 * body, and the decision service never sees this format.
 *
 * The wire id is `w{index}` and the neutral id is `question.id`; `parseJevResponse` maps the
 * former back to the latter, which is what lets answers arrive shuffled and still land correctly.
 */

import { assembleById } from "./assembly"
import type { Question, QuestionType } from "../predictive/model"

export const JEV_QUESTION_TYPES = ["noul", "choice", "score"] as const
export type JevQuestionType = (typeof JEV_QUESTION_TYPES)[number]

/** How each neutral question type is asked on the wire: a binary question is Jev's `noul`. */
const JEV_TYPE: Record<QuestionType, JevQuestionType> = { binary: "noul", choice: "choice", score: "score" }

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
  /** Keyed by the neutral question id; an answer Jev did not send is absent, not guessed. */
  answers: Record<string, JevAnswer>
}

/** A question as it travels: the neutral id is replaced by its position (`w{index}`). */
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

/** The `w{index}` wire id of each question, in the order they are sent. */
export const wireID = (index: number): string => `w${index}`

/** The neutral questions in Jev's encoding: positional ids, `noul` for binary, options as `choices`. */
export function wireQuestions(questions: readonly Question[]): JevWireQuestion[] {
  return questions.map((question, index) => ({
    id: wireID(index),
    type: JEV_TYPE[question.type],
    prompt: question.prompt,
    ...(question.type === "binary" ? {} : { choices: question.options }),
  }))
}

/**
 * Reads an answer body by question id.
 *
 * The type is taken from what was asked, not from what came back: a provider that mislabels an
 * answer cannot turn a `noul` into a `choice`. A question whose answer is missing or malformed is
 * simply absent from the result, so the caller can tell "not sent" from "sent as a default".
 */
export function parseJevResponse(payload: unknown, questions: readonly Question[]): JevPrediction {
  const envelope = isPlainObject(payload) ? payload : {}
  const modelVersion = typeof envelope.model === "string" ? envelope.model : undefined
  const source = isPlainObject(envelope.answers) ? envelope.answers : isPlainObject(envelope.results) ? envelope.results : {}

  const parsed = new Map<string, JevAnswer>()
  questions.forEach((question, index) => {
    const answer = PARSERS[JEV_TYPE[question.type]](source[wireID(index)])
    if (answer) parsed.set(question.id, answer)
  })
  // Assembly by id: the answer that came back under `w{index}` is placed on its question, in order.
  return { modelVersion, answers: Object.fromEntries(assembleById(questions.map((question) => question.id), parsed)) }
}
