/**
 * The Jev adapter: transport, wire encoding and the `PredictiveModel` (FH-012, AH-C01).
 *
 * Two modes exist because the plan separates a live turn from background work. `predictOne` answers
 * one state with a strict timeout and no queue: the hot path must never wait for a batch.
 * `predictMany` serves batch and background work: it groups every question of a state into **one**
 * request — the primary cost lever, since an extra question barely moves latency — and fans out over
 * the states. Answer assembly is by `w{index}` id, so shuffled responses still land correctly.
 *
 * Everything Jev-specific lives here and in `jev-parse.ts`: the TypeSafe envelope, the `w{index}`
 * ids, `noul/choice/score`, and turning Jev's answers into neutral distributions. The decision
 * service hands this adapter the guard's neutral input and gets neutral answers back. The client
 * re-checks the egress allowlist before a byte is sent, and the transport is an injected `fetch`, so
 * tests never touch the network.
 */

import { decisionKinds } from "../decision"
import type { JevConfig } from "../config"
import { estimateTokens } from "../context"
import type { EgressGuard } from "../egress"
import type { Answer, Prediction, PredictionState, PredictiveModel, Question } from "../predictive/model"
import { parseJevResponse, wireQuestions } from "./jev-parse"
import type { JevAnswer, JevPrediction } from "./jev-parse"
import { DecisionUnavailable } from "./provider"

/** The narrow slice of a `fetch` response the adapter uses; a `Response` satisfies it as it is. */
export type JevFetchResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type JevFetch = (input: {
  url: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<JevFetchResponse>

type TimerHandle = ReturnType<typeof setTimeout>
export type JevTimers = {
  set: (fn: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

/** The process `fetch`, shaped to `JevFetch`; the only place the global is touched. */
export const defaultJevFetch: JevFetch = async ({ url, headers, body, signal }) => {
  const response = await fetch(url, { method: "POST", headers, body, signal })
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: () => response.json() as Promise<unknown>,
  }
}

/** A parsed prediction plus the size of the body that asked it, which Jev does not report itself. */
export type JevResult = JevPrediction & { inputTokens: number }

export type JevClient = {
  predictOne(state: PredictionState, questions: readonly Question[], signal?: AbortSignal): Promise<JevResult>
  predictMany(
    states: readonly PredictionState[],
    questions: readonly Question[],
    signal?: AbortSignal,
  ): Promise<JevResult[]>
}

/** Jev's declared price: $42 per billion input tokens. */
export const JEV_USD_PER_INPUT_TOKEN = 42 / 1_000_000_000

const reasonForStatus = (status: number): "rate-limited" | "unauthorized" | "malformed" | "network" => {
  if (status === 401 || status === 403) return "unauthorized"
  if (status === 429 || status === 529) return "rate-limited"
  if (status === 422) return "malformed"
  return "network"
}

/**
 * `Retry-After` is seconds or an HTTP date; anything else is ignored rather than guessed. A past
 * date becomes zero, which means "retry now".
 */
const retryAfterMsFrom = (header: string | null, now: () => number): number | undefined => {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - now())
  return undefined
}

/** Jev's identity for the egress guard: the client re-checks Jev's own consent, not anyone else's. */
const JEV = { id: "jev", locality: "remote" } as const

export function createJevClient(input: {
  fetch: JevFetch
  egress: EgressGuard
  config: () => JevConfig
  /** Resolved from the environment by the caller; never part of the config block. */
  apiKey?: string
  now?: () => number
  timers?: JevTimers
}): JevClient {
  const now = input.now ?? Date.now
  const timers = input.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) }

  const post = async (body: string, timeoutMs: number, caller?: AbortSignal): Promise<JevFetchResponse> => {
    const controller = new AbortController()
    let timedOut = false
    const handle = timers.set(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
    try {
      return await input.fetch({
        url: input.config().endpoint,
        headers: { "content-type": "application/json", ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}) },
        body,
        signal,
      })
    } catch (error) {
      if (timedOut) throw new DecisionUnavailable("timeout")
      throw error
    } finally {
      timers.clear(handle)
    }
  }

  const predictOne = async (
    state: PredictionState,
    questions: readonly Question[],
    signal?: AbortSignal,
  ): Promise<JevResult> => {
    if (!input.egress.allows(JEV, state.kind, state.projectID)) throw new DecisionUnavailable("egress-denied")
    const config = input.config()
    // The envelope carries only what the guard wrote — the redacted state text and the redacted
    // prompts — re-keyed to positional wire ids, so there is no second path that could skip redaction.
    const body = JSON.stringify({ state: state.text, model: config.model, questions: wireQuestions(questions) })
    const response = await post(body, config.timeoutMs, signal)
    if (!response.ok) {
      throw new DecisionUnavailable(reasonForStatus(response.status), {
        retryAfterMs: retryAfterMsFrom(response.headers.get("retry-after"), now),
      })
    }
    const payload = await response.json().catch(() => {
      throw new DecisionUnavailable("malformed")
    })
    const prediction = parseJevResponse(payload, questions)
    // An empty answer set for questions that were asked means the body was not a Jev answer.
    if (questions.length > 0 && Object.keys(prediction.answers).length === 0) {
      throw new DecisionUnavailable("malformed")
    }
    return { ...prediction, inputTokens: estimateTokens(body) }
  }

  return {
    predictOne,
    // One state, one request: every question of a state travels together and states fan out.
    predictMany: (states, questions, signal) =>
      Promise.all(states.map((state) => predictOne(state, questions, signal))),
  }
}

// ---- the model: Jev answers as neutral distributions (AH-C01) --------------------------------

/**
 * One Jev answer as a neutral distribution. A `noul` probability is `p(yes)`, not a confidence, so it
 * becomes `{ yes, no }` with no confidence. A `score` is an index into the question's ordered options
 * (its legend), rounded and clamped, and becomes the chosen option.
 */
const toAnswer = (question: Question, answer: JevAnswer): Answer => {
  if (answer.type === "noul") return { probabilities: { yes: answer.probability, no: 1 - answer.probability } }
  const confidence = answer.confidence !== undefined ? { confidence: answer.confidence } : {}
  if (answer.type === "choice") return { probabilities: answer.probabilities, choice: answer.choice, ...confidence }
  const options = question.type === "binary" ? [] : question.options
  const choice = options[Math.min(options.length - 1, Math.max(0, Math.round(answer.score)))]
  return { probabilities: answer.probabilities, ...(choice !== undefined ? { choice } : {}), ...confidence }
}

/**
 * Jev as a `PredictiveModel`: remote, able to answer every kind. It applies no thresholds — that is
 * the service's job — and it never touches the network itself: the `JevClient` owns the request.
 * Jev does not report usage, so the body's token estimate is the usage and its declared price the cost.
 */
export function createJevModel(input: { client: JevClient; now?: () => number }): PredictiveModel {
  const now = input.now ?? Date.now
  return {
    ...JEV,
    supports: decisionKinds(),
    async predict(state, questions, options): Promise<Prediction> {
      // Jev cannot answer an empty question set; a state with nothing to ask is not a Jev answer.
      if (questions.length === 0) throw new DecisionUnavailable("malformed")
      const startedAt = now()
      const result = await input.client.predictOne(state, questions, options.signal)
      const answers = Object.fromEntries(
        questions.flatMap((question) => {
          const answer = result.answers[question.id]
          return answer ? [[question.id, toAnswer(question, answer)] as const] : []
        }),
      )
      return {
        answers,
        latencyMs: now() - startedAt,
        usage: { inputTokens: result.inputTokens, costUsd: result.inputTokens * JEV_USD_PER_INPUT_TOKEN },
        model: { id: JEV.id, ...(result.modelVersion ? { version: result.modelVersion } : {}) },
      }
    },
  }
}
