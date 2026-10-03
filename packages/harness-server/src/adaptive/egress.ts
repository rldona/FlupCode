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
 * from it in its own provider module, so the guard stays the same whichever model is asked.
 */

import type { DecisionSpec, SpecRequest } from "./decision"
import { decisionInputsHash, isDecisionKind } from "./decision"
import type { DecisionRegistry, KindOf, KindSpec } from "./decisions/define"
import { DECISIONS } from "./decisions/registry"
import type { AdaptiveConfig } from "./config"
import { DEFAULT_MAX_INPUT_CHARS } from "./config"
import { redactText } from "./redaction"
import { questionID } from "./questions"
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

export type EgressGuard<S extends KindSpec = DecisionSpec> = {
  /** Whether `model` may be asked about `kind` for `projectID`: its provider's consent, or local. */
  allows(model: EgressSubject, kind: string, projectID: string | undefined): boolean
  /**
   * Builds the whole model input, redacting and bounding it; it never returns the raw state.
   *
   * The state *and* the questions are written here, so no other path can hand a model a prompt built
   * from raw state. When no questions are given the shared planner derives them from the request, so
   * the input is complete whichever caller asks and the hash always covers what a model receives.
   * The state is the kind's own outward view of it (its definition's `egress`).
   */
  prepare<Q extends KindOf<S>>(request: SpecRequest<S, Q>, questions?: readonly Question[]): PreparedInput
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

export function createAdaptiveEgressGuard<S extends KindSpec = DecisionSpec>(deps: {
  config: () => AdaptiveConfig
  /** Known values to delete outright (for example an active credential); none by default. */
  secrets?: () => string[]
  /** The decision kinds it prepares (PI-02); the server's own registry unless a caller brings one. */
  decisions?: DecisionRegistry<S>
}): EgressGuard<S> {
  // Without a registry of its own the guard prepares the server's kinds, which is the spec `S`
  // defaults to; only a caller that brings a registry names another spec.
  const decisions = deps.decisions ?? (DECISIONS as unknown as DecisionRegistry<S>)
  const allows = (model: EgressSubject, kind: string, projectID: string | undefined): boolean => {
    const config = deps.config()
    if (!config.enabled) return false
    if (model.locality === "local") return true
    const consent = Object.hasOwn(config.egress.providers, model.id) ? config.egress.providers[model.id] : undefined
    return (
      consent !== undefined &&
      consent.enabled &&
      projectID !== undefined &&
      consent.projects.includes(projectID) &&
      // Consent is given per configured kind; a kind a caller registered beyond them has none.
      isDecisionKind(kind) &&
      consent.kinds[kind]
    )
  }

  const prepare = <Q extends KindOf<S>>(
    request: SpecRequest<S, Q>,
    questions: readonly Question[] = decisions.get(request.kind).questions(request.state),
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
    // The bound is the `maxInputChars` of the provider the kind is assigned to (PI-01). The input is
    // prepared before the service checks that model may be asked (every decision is hashed, answered
    // by a model or not), but the assignment is already known: it is the config's, read here.
    const assigned = config.models[request.kind]
    const provider =
      assigned !== undefined && Object.hasOwn(config.providers, assigned) ? config.providers[assigned] : undefined
    const bounded = boundInput(
      redactText(JSON.stringify(decisions.get(request.kind).egress(request.state)), secrets),
      asked,
      Math.max(0, provider?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS),
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
