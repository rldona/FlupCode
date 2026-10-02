/**
 * The one place state is serialized outward (FH-014, AH-C01).
 *
 * No model is handed anything the guard did not write: `prepare` redacts, bounds and summarizes a
 * request into the neutral input every predictive model receives, and `allows` decides whether a
 * model may be asked at all. Consent is per provider (AH-C03): a remote model is only asked when its
 * own `egress.providers.<id>` entry is on, lists the project and allowlists the kind, so consenting to
 * one provider never lets anything reach another. A local model sends nothing off the machine and
 * needs no consent, but the adaptive kill switch stops it like every other model. This is the trust
 * invariant as a rule at the writer, not as a separate service.
 *
 * The guard writes a neutral input, not a wire body: each remote model serializes its own envelope
 * from it (Jev's lives in `providers/jev.ts`), so the guard stays the same whichever model is asked.
 */

import { createHash } from "node:crypto"
import type { AnyDecisionRequest, DecisionKind } from "./decision"
import { decisionInputsHash } from "./decision"
import type { AdaptiveConfig } from "./config"
import { redactText } from "./redaction"
import { questionID, questionsFor } from "./questions"
import type { PredictionState, PredictiveModel, Question } from "./predictive/model"

/** What the guard needs to know about the model it is asked about: who it is and where it runs. */
export type EgressSubject = Pick<PredictiveModel, "id" | "locality">

/** What `prepare` hands the service: the model's input, its serialization, hash and audit summary. */
export type PreparedInput = {
  state: PredictionState
  /** The planned questions, redacted, bounded and renamed to their positional ids (`questionID`). */
  questions: Question[]
  /** The whole input as one string: what the hash covers and what the budget estimate is taken from. */
  serialized: string
  hash: string
  summary: Record<string, unknown>
}

export type EgressGuard = {
  /** Whether `model` may be asked about `kind` for `projectID`: its provider's consent, or local. */
  allows(model: EgressSubject, kind: DecisionKind, projectID: string | undefined): boolean
  /**
   * Builds the whole model input, redacting and bounding it; it never returns the raw state.
   *
   * The state *and* the questions are written here, so no other path can hand a model a prompt built
   * from raw state. When no questions are given the shared planner derives them from the request, so
   * the input is complete whichever caller asks and the hash always covers what a model receives.
   */
  prepare(request: AnyDecisionRequest, questions?: readonly Question[]): PreparedInput
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

/**
 * The state as a model may see it. A project is named by its absolute path on the acting paths (a
 * run's directory), which says who the person is and how their disk is laid out (PI-03): the state
 * carries a stable digest of it instead, so one project still reads as one project. The request's own
 * `projectID` keeps the path, because the consent check and a local engine session need it, and it
 * never leaves.
 */
const outwardState = (state: unknown): unknown =>
  isPlainObject(state) && typeof state.projectID === "string" && state.projectID !== ""
    ? { ...state, projectID: projectDigest(state.projectID) }
    : state

const projectDigest = (projectID: string): string =>
  `project:${createHash("sha256").update(projectID).digest("hex").slice(0, 16)}`

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
 * Bounds the whole serialized input — state and questions, not only the state — to the budget.
 *
 * The variable text, the state string and every question prompt, is trimmed to the longest prefix
 * whose *serialized* form fits; a binary search is used because escaping quotes and backslashes makes
 * the message longer than the text it carries. The state is trimmed first (it is the largest part),
 * then each prompt in order if the questions alone still exceed the budget. The empty envelope (the
 * question shells) is the floor: dropping a question would ask a different question.
 */
const boundInput = (state: string, questions: Question[], budget: number): { state: string; questions: Question[] } => {
  const serialize = (stateText: string, asked: readonly Question[]) =>
    JSON.stringify({ state: stateText, questions: asked })
  if (serialize(state, questions).length <= budget) return { state, questions }
  const shell = questions.map((question) => ({ ...question, prompt: "" }))
  if (serialize("", shell).length >= budget) return { state: "", questions: shell }

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

  const stateText = trimToFit(state, (candidate) => serialize(candidate, questions))
  const asked = questions.reduce<Question[]>((current, question, index) => {
    const trimmed = trimToFit(question.prompt, (candidate) =>
      serialize(
        stateText,
        current.map((entry, position) => (position === index ? { ...entry, prompt: candidate } : entry)),
      ),
    )
    return current.map((entry, position) => (position === index ? { ...entry, prompt: trimmed } : entry))
  }, questions)
  return { state: stateText, questions: asked }
}

export function createAdaptiveEgressGuard(deps: {
  config: () => AdaptiveConfig
  /** Known values to delete outright (for example an active credential); none by default. */
  secrets?: () => string[]
}): EgressGuard {
  const allows = (model: EgressSubject, kind: DecisionKind, projectID: string | undefined): boolean => {
    const config = deps.config()
    if (!config.enabled) return false
    if (model.locality === "local") return true
    const consent = Object.hasOwn(config.egress.providers, model.id) ? config.egress.providers[model.id] : undefined
    return (
      consent !== undefined &&
      consent.enabled &&
      projectID !== undefined &&
      consent.projects.includes(projectID) &&
      consent.kinds[kind]
    )
  }

  const prepare = (
    request: AnyDecisionRequest,
    questions: readonly Question[] = questionsFor(request),
  ): PreparedInput => {
    const config = deps.config()
    const secrets = deps.secrets?.() ?? []
    // Every string of a question is swept, prompts first: a prompt is built from state and is the
    // path the leak took. Options are enums or roster names, but they travel too and get the same
    // pass. The caller's id never travels: the question is renamed to its position.
    const asked = questions.map((question, index): Question => {
      const prompt = redactText(question.prompt, secrets)
      if (question.type === "binary") return { id: questionID(index), type: question.type, prompt }
      return {
        id: questionID(index),
        type: question.type,
        prompt,
        options: question.options.map((option) => redactText(option, secrets)),
      }
    })
    // The bound is still read from the Jev slot of the config. The input is prepared before a model is
    // chosen (every decision is hashed, answered by a model or not), so it cannot depend on which
    // provider is asked; a per-provider bound would need a second, per-model preparation.
    const bounded = boundInput(
      redactText(JSON.stringify(outwardState(request.state)), secrets),
      asked,
      Math.max(0, config.jev.maxInputTokens),
    )
    const serialized = JSON.stringify({ state: bounded.state, questions: bounded.questions })
    const hash = decisionInputsHash(request.kind, serialized)
    return {
      state: {
        kind: request.kind,
        ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
        text: bounded.state,
      },
      questions: bounded.questions,
      serialized,
      hash,
      summary: { kind: request.kind, digest: hash, bytes: serialized.length, fields: summarize(request.state) },
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
