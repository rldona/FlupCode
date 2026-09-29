/**
 * The one place state is serialized outward (FH-014).
 *
 * No other code path builds a body for Jev: `prepare` redacts, bounds and summarizes, and `allows`
 * decides whether anything may leave at all. The posture is opt-in three times over — the global Jev
 * switch, the project list, and the per-kind allowlist — so with Jev off, nothing leaves whatever
 * else is configured. This is the trust invariant as a rule at the writer, not as a separate service.
 */

import type { AnyDecisionRequest, DecisionKind } from "./decision"
import { decisionInputsHash } from "./decision"
import type { AdaptiveConfig } from "./config"
import { redactText } from "./redaction"
import { questionsFor, wireQuestions } from "./questions"
import type { Question, WireQuestion } from "./questions"

export type EgressGuard = {
  allows(kind: DecisionKind, projectID: string | undefined): boolean
  /**
   * Builds the whole outbound body, redacting and bounding it; it never returns the raw state.
   *
   * The state *and* the questions are written here, so no other path can serialize a prompt built
   * from raw state. When no questions are given the shared planner derives them from the request, so
   * the body is complete whichever caller asks and the hash always covers what is really sent.
   */
  prepare(
    request: AnyDecisionRequest,
    questions?: readonly Question[],
  ): { body: string; hash: string; summary: Record<string, unknown> }
  /**
   * The same redaction `prepare` applies, over any value, for a writer that persists a decision.
   *
   * The audit must never retain what egress would not let out (ADR-0017 §3), so the service passes
   * the answer and the baseline through here before `createDecision`. Keeping it on the guard is what
   * makes the known secrets and the pattern sweep one source of truth.
   */
  redact(value: unknown): unknown
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep redaction: every string is swept, arrays and objects are walked, other values pass through. */
const redactValue = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets))
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]))
  return value
}

/** Counters, lengths and field names only: a summary that can never carry a secret or raw text. */
const summarize = (state: unknown): Record<string, unknown> => {
  if (!isPlainObject(state)) return {}
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? { count: value.length }
        : typeof value === "string"
          ? { chars: value.length }
          : isPlainObject(value)
            ? { fields: Object.keys(value) }
            : value,
    ]),
  )
}

/**
 * Bounds the whole serialized body — state, model and questions, not only the state — to the budget.
 *
 * The variable text, the state string and every question prompt, is trimmed to the longest prefix
 * whose *serialized* form fits; a binary search is used because escaping quotes and backslashes makes
 * the message longer than the text it carries. The state is trimmed first (it is the largest part),
 * then each prompt in order if the questions alone still exceed the budget. The empty envelope
 * (model plus question shells) is the floor: dropping a question would ask a different question.
 */
const boundBody = (state: string, questions: WireQuestion[], model: string, budget: number): string => {
  const serialize = (stateText: string, asked: readonly WireQuestion[]) =>
    JSON.stringify({ state: stateText, model, questions: asked })
  if (serialize(state, questions).length <= budget) return serialize(state, questions)
  const shell = (asked: readonly WireQuestion[]) => asked.map((question) => ({ ...question, prompt: "" }))
  if (serialize("", shell(questions)).length >= budget) return serialize("", shell(questions))

  // The longest prefix of `text` whose serialization, with the rest as it stands, stays under budget.
  const trimToFit = (text: string, apply: (candidate: string) => string): string => {
    let low = 0
    let high = text.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (apply(text.slice(0, mid)).length <= budget) low = mid
      else high = mid - 1
    }
    return text.slice(0, low)
  }

  let stateText = trimToFit(state, (candidate) => serialize(candidate, questions))
  let asked = questions.map((question) => ({ ...question }))
  asked.forEach((question, index) => {
    const trimmed = trimToFit(question.prompt, (candidate) =>
      serialize(
        stateText,
        asked.map((entry, position) => (position === index ? { ...entry, prompt: candidate } : entry)),
      ),
    )
    asked = asked.map((entry, position) => (position === index ? { ...entry, prompt: trimmed } : entry))
  })
  return serialize(stateText, asked)
}

export function createAdaptiveEgressGuard(deps: {
  config: () => AdaptiveConfig
  /** Known values to delete outright (for example an active credential); none by default. */
  secrets?: () => string[]
}): EgressGuard {
  const allows = (kind: DecisionKind, projectID: string | undefined): boolean => {
    const config = deps.config()
    return (
      config.egress.enabled &&
      projectID !== undefined &&
      config.egress.projects.includes(projectID) &&
      config.egress.kinds[kind]
    )
  }

  const prepare = (request: AnyDecisionRequest, questions: readonly Question[] = questionsFor(request)) => {
    const config = deps.config()
    const secrets = deps.secrets?.() ?? []
    // Every string of a question is swept, prompts first: a prompt is built from state and is the
    // path the leak took. Choices are enums, but they travel too and get the same pass.
    const asked = wireQuestions(
      questions.map((question) => ({
        ...question,
        prompt: redactText(question.prompt, secrets),
        ...(question.choices ? { choices: question.choices.map((choice) => redactText(choice, secrets)) } : {}),
      })),
    )
    const state = redactText(JSON.stringify(request.state), secrets)
    const body = boundBody(state, asked, config.jev.model, Math.max(0, config.jev.maxInputTokens))
    const hash = decisionInputsHash(request.kind, body)
    return {
      body,
      hash,
      summary: { kind: request.kind, digest: hash, bytes: body.length, fields: summarize(request.state) },
    }
  }

  const redact = (value: unknown): unknown => redactValue(value, deps.secrets?.() ?? [])

  return { allows, prepare, redact }
}

/**
 * The name the phase documents use.
 *
 * The factory is also exported as `createAdaptiveEgressGuard` so `index.ts`, which also builds the
 * browser's unrelated egress guard, can import both without aliasing either.
 */
export const createEgressGuard = createAdaptiveEgressGuard
