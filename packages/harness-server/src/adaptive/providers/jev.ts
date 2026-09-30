/**
 * The Jev transport adapter (FH-012).
 *
 * Two modes exist because the plan separates a live turn from background work. `predictOne` answers
 * one state with a strict timeout and no queue: the hot path must never wait for a batch.
 * `predictMany` serves batch and background work: it groups every question of a state into **one**
 * request — the primary cost lever, since an extra question barely moves latency — and fans out over
 * the states. Answer assembly is by `w{index}` id, so shuffled responses still land correctly.
 *
 * Nothing here builds a body without `EgressGuard.prepare`: the guard is a required dependency, not
 * an option, and a kind or project that is not allowlisted fails before a single byte is sent. The
 * transport is an injected `fetch`, so tests never touch the network.
 */

import type { AnyDecisionRequest, DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import {
  AGENT_ROUTES,
  DECISION_TIERS,
  ITEM_DISPOSITIONS,
  TOOL_RISKS,
  isReflectionIntent,
} from "../decision"
import type { JevConfig } from "../config"
import type { EgressGuard } from "../egress"
import { questionsFor } from "../questions"
import { clampLearned } from "../risk"
import { parseJevResponse } from "./jev-parse"
import type { JevPrediction, JevQuestion } from "./jev-parse"
import { DecisionUnavailable } from "./provider"
import type { DecisionProvider, ProviderAnswer } from "./provider"

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

export type JevClient = {
  predictOne(request: AnyDecisionRequest, questions: readonly JevQuestion[], signal?: AbortSignal): Promise<JevPrediction>
  predictMany(requests: readonly AnyDecisionRequest[], questions: readonly JevQuestion[], signal?: AbortSignal): Promise<JevPrediction[]>
}

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
    request: AnyDecisionRequest,
    questions: readonly JevQuestion[],
    signal?: AbortSignal,
  ): Promise<JevPrediction> => {
    if (!input.egress.allows(request.kind, request.projectID)) throw new DecisionUnavailable("egress-denied")
    const config = input.config()
    // The guard writes the whole body — state and question prompts — so `post` only carries what
    // `prepare` returned: there is no second serialization path that could forget the redaction.
    const prepared = input.egress.prepare(request, questions)
    const response = await post(prepared.body, config.timeoutMs, signal)
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
    return prediction
  }

  return {
    predictOne,
    // One state, one request: every question of a state travels together and states fan out.
    predictMany: (requests, questions, signal) =>
      Promise.all(requests.map((request) => predictOne(request, questions, signal))),
  }
}

// ---- the provider that translates a prediction back to a typed answer (FH-012) ----------------

/**
 * What one prediction means for one kind: the typed answer, the probabilities behind it and, only
 * when Jev reported one, its confidence in the chosen label. A `noul` probability is `p(yes)`, not a
 * confidence, so it travels in `probabilities` and the service calibrates it (`chosenProbability`).
 */
type Interpretation<Q extends DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  confidence?: number
  probabilities?: Record<string, number>
}

type Interpreter = {
  [Q in DecisionKind]: (prediction: JevPrediction) => Interpretation<Q> | undefined
}

const isDisposition = (value: string | undefined): value is (typeof ITEM_DISPOSITIONS)[number] =>
  value !== undefined && ITEM_DISPOSITIONS.some((candidate) => candidate === value)

const isTier = (value: string | undefined): value is (typeof DECISION_TIERS)[number] =>
  value !== undefined && DECISION_TIERS.some((candidate) => candidate === value)

const isAgent = (value: string | undefined): value is (typeof AGENT_ROUTES)[number] =>
  value !== undefined && AGENT_ROUTES.some((candidate) => candidate === value)

const isRisk = (value: string | undefined): value is (typeof TOOL_RISKS)[number] =>
  value !== undefined && TOOL_RISKS.some((candidate) => candidate === value)

const interpretations: Interpreter = {
  completion: (prediction) => {
    const answer = prediction.answers.verdict
    if (answer?.type !== "noul") return undefined
    return {
      answer: { verdict: answer.probability >= 0.5 ? "complete" : "not_complete" },
      probabilities: { complete: answer.probability, not_complete: 1 - answer.probability },
    }
  },
  skillRelevance: (prediction) => {
    const gates = Object.entries(prediction.answers).flatMap(([name, answer]) =>
      answer.type === "noul" ? [[name, answer.probability] as const] : [],
    )
    return {
      answer: { load: gates.filter(([, probability]) => probability >= 0.5).map(([name]) => name) },
      probabilities: Object.fromEntries(gates),
    }
  },
  contextItem: (prediction) => {
    const decisions = Object.entries(prediction.answers).flatMap(([id, answer]) =>
      answer.type === "choice" && isDisposition(answer.choice)
        ? [{ id, disposition: answer.choice, confidence: answer.confidence ?? 0 }]
        : [],
    )
    if (decisions.length === 0) return { answer: { decisions: [] } }
    return {
      answer: { decisions: decisions.map(({ id, disposition }) => ({ id, disposition })) },
      confidence: Math.min(...decisions.map((decision) => decision.confidence)),
    }
  },
  modelRoute: (prediction) => {
    const answer = prediction.answers.tier
    if (answer?.type !== "choice" || !isTier(answer.choice)) return undefined
    return { answer: { tier: answer.choice }, confidence: answer.confidence, probabilities: answer.probabilities }
  },
  agentRoute: (prediction) => {
    const answer = prediction.answers.agent
    if (answer?.type !== "choice" || !isAgent(answer.choice)) return undefined
    return { answer: { agent: answer.choice }, confidence: answer.confidence, probabilities: answer.probabilities }
  },
  toolRisk: (prediction) => {
    const answer = prediction.answers.risk
    if (answer?.type !== "score") return undefined
    const index = Math.min(TOOL_RISKS.length - 1, Math.max(0, Math.round(answer.score)))
    const risk = TOOL_RISKS[index]
    if (!risk) return undefined
    // A learned score may only raise confirmation, never exceed the ceiling (FH-063, ADR-0023 §5).
    return { answer: { risk: clampLearned(risk) }, confidence: answer.confidence, probabilities: answer.probabilities }
  },
  failure: (prediction) => {
    const answer = prediction.answers.verdict
    if (answer?.type !== "noul") return undefined
    return {
      answer: { verdict: answer.probability >= 0.5 ? "intervene" : "continue" },
      probabilities: { continue: 1 - answer.probability, intervene: answer.probability },
    }
  },
  // The `noul` gate decides reusable; a missing or unrecognised intent falls to the safe `add`, and
  // the target is only carried when Jev named one. Confidence is the intent's, when reported; the
  // service folds in the gate's certainty and keeps the weakest, so a noisy intent can pull a
  // confident gate below the policy and the service degrades to inert.
  skillReflection: (prediction) => {
    const reusable = prediction.answers.reusable
    if (reusable?.type !== "noul") return undefined
    const intent = prediction.answers.intent
    const chosen =
      intent?.type === "choice" && isReflectionIntent(intent.choice) ? intent.choice : "add"
    const target = prediction.answers.target?.type === "choice" ? prediction.answers.target.choice : undefined
    return {
      answer: { reusable: reusable.probability >= 0.5, intent: chosen, ...(target ? { target } : {}) },
      ...(intent?.type === "choice" && intent.confidence !== undefined ? { confidence: intent.confidence } : {}),
      probabilities: { reusable: reusable.probability },
    }
  },
}

/**
 * The transport adapter as a `DecisionProvider`: it asks the questions of a state and maps the
 * prediction back to the typed answer. It applies no thresholds — that is the service's job — and it
 * never touches the network itself: the `JevClient` it is given owns the request.
 */
export function createJevProvider(input: { client: JevClient }): DecisionProvider {
  return {
    id: "jev",
    async answer<Q extends DecisionKind>(request: DecisionRequest<Q>, signal: AbortSignal): Promise<ProviderAnswer<Q>> {
      const questions = questionsFor(request)
      if (questions.length === 0) throw new DecisionUnavailable("malformed")
      // A sound widening (`decision.test.ts` proves every `DecisionRequest<Q>` is a member of the
      // union); the generic cannot reach `predictOne`'s union parameter on its own.
      const prediction = await input.client.predictOne(request as AnyDecisionRequest, questions, signal)
      const interpreted = interpretations[request.kind](prediction)
      if (!interpreted) throw new DecisionUnavailable("malformed")
      return {
        answer: interpreted.answer,
        ...(interpreted.confidence !== undefined ? { confidence: interpreted.confidence } : {}),
        ...(interpreted.probabilities !== undefined ? { probabilities: interpreted.probabilities } : {}),
        ...(prediction.modelVersion ? { modelVersion: prediction.modelVersion } : {}),
        latencyMs: 0,
      }
    },
  }
}
