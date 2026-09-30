/**
 * The decision service: deterministic first, a predictive model optional, always audited (FH-015).
 *
 * Every decision starts from the deterministic baseline, which is stored even when a model wins so
 * `explain` never re-executes and never spends. The service applies the thresholds (they live in
 * `DecisionPolicy`, not in the model), records a redacted summary and the baseline, and degrades to
 * the baseline with a reason whenever the model cannot answer.
 *
 * Models come from a static registry handed in at startup, and `adaptive.models.<kind>` picks one per
 * kind (AH-C01). The service only speaks the neutral contract (`predictive/model.ts`): it plans the
 * questions, hands the guard's redacted input to the model, reads the typed answer back from the
 * distributions and derives confidence itself. Governance — breaker, budget, single-flight and the
 * hot deadline — stays here, keyed by the model's id.
 *
 * The baseline is not a model in the registry. It answers in the kind's typed shape with the rule that
 * produced it, not in distributions; it must run for every decision, including the ones a model wins,
 * and never under the governor, the egress guard or the confidence gate. Routing it through the model
 * contract would invent certainties for a rule and give the gate something to reject.
 *
 * `explain` is built only from the stored row and the episode it points at — no model is called,
 * which is what makes the answer reproducible.
 */

import { allowsModel } from "./decision"
import type {
  AnyDecisionRequest,
  DecisionKind,
  DecisionPolicy,
  DecisionRequest,
  DecisionResult,
  DecisionSource,
  DecisionSpec,
  DegradedReason,
} from "./decision"
import type { AdaptiveConfig } from "./config"
import { estimateTokens } from "./context"
import type { EgressGuard, PreparedInput } from "./egress"
import { boundAnswer, boundSummary, decisionID } from "./decision-record"
import { questionsFor, readAnswers } from "./questions"
import type { PredictiveModel, Question } from "./predictive/model"
import { deterministicBaseline } from "./providers/deterministic"
import type { DeterministicBaseline } from "./providers/deterministic"
import { DecisionUnavailable, degradedReasonOf } from "./providers/provider"
import { governorKey } from "./providers/governor"
import type { Governor } from "./providers/governor"
import type {
  DecisionFilter,
  DecisionRepository,
  SessionEpisode,
  StoredDecision,
  StoredDecisionInput,
} from "../types"

/** A repository that can also walk from a decision to the episode it belongs to. */
export type DecisionServiceRepository = DecisionRepository & {
  getEpisode(id: string): SessionEpisode | undefined
}

export type DecisionExplanation = {
  id: string
  question: string
  answer: unknown
  baseline: { answer: unknown; rule: string }
  why: string
  source: StoredDecision["source"]
  provider: string
  /** The model that was asked, when one was, even if it could not answer. */
  attemptedProvider?: string
  modelVersion?: string
  /** The predictive model consulted and what it cost (AH-C02); absent when only the baseline answered. */
  providerID?: string
  providerVersion?: string
  costUsd?: number
  inputTokens?: number
  /** The stored kind or source this build could not interpret. */
  raw?: StoredDecision["raw"]
  confidence?: number
  probabilities?: Record<string, number>
  latencyMs: number
  degraded: boolean
  degradedReason?: DegradedReason
  episodeID?: string
  evidenceRefs: string[]
  decidedAt: number
}

/**
 * Which governor entry a prediction goes through (ADR-0017 §4).
 *
 * `hot` is the live path: it never queues behind the adaptive limiter and is bounded end to end by
 * the request's `timeoutMs`, so a live turn cannot wait for a model because a background batch
 * saturates the limiter. `batch` is the default for background work (the shadow), which goes through the
 * limiter and still shares the breaker, budget and single-flight.
 */
export type PredictionMode = "hot" | "batch"

export type DecisionService = {
  /**
   * `shadow` marks the audit row: `true` (the default) records a decision the harness does not act
   * on, which is every episode decision; an acting path — the relevance line — passes `false`. The
   * default keeps the Phase 2/3a/3b shadow byte-identical when no flag is given.
   */
  predict<Q extends DecisionKind>(
    request: DecisionRequest<Q>,
    mode?: PredictionMode,
    shadow?: boolean,
  ): Promise<DecisionResult<Q>>
  decisions(filter?: DecisionFilter): StoredDecision[]
  explain(id: string): DecisionExplanation | undefined
}

/** What the model attempt yields, before the deterministic baseline is folded back in. */
type Improved<Q extends DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  source: DecisionSource
  provider: string
  attemptedProvider?: string
  providerID?: string
  providerVersion?: string
  costUsd?: number
  inputTokens?: number
  confidence?: number
  probabilities?: Record<string, number>
  modelVersion?: string
  latencyMs: number
  degraded: boolean
  degradedReason?: DegradedReason
}

/** A readable question per kind; a summary is all the row kept, so the question is generic. */
const QUESTIONS: Record<DecisionKind, string> = {
  completion: "Should this episode be marked complete?",
  skillRelevance: "Which skills should be loaded for this objective?",
  contextItem: "What disposition should each context item take?",
  modelRoute: "Which model tier should this task use?",
  agentRoute: "Which agent route should this objective take?",
  toolRisk: "How risky is this tool call?",
  failure: "Should the harness intervene in this loop?",
  skillReflection: "Does this episode carry a reusable lesson, and what change does it call for?",
}

/**
 * What a kind's `probabilities` map means. Most kinds report one **distribution** over the labels
 * they can answer; `skillRelevance` and `skillReflection` report independent binary **gates**, one
 * `p(yes)` per key, which do not sum to one and whose maximum says nothing about a confident "no".
 */
const PROBABILITY_SHAPE: Record<DecisionKind, "distribution" | "gates"> = {
  completion: "distribution",
  skillRelevance: "gates",
  contextItem: "distribution",
  modelRoute: "distribution",
  agentRoute: "distribution",
  toolRisk: "distribution",
  failure: "distribution",
  skillReflection: "gates",
}

/**
 * The probability of the answer actually chosen, read from the answer's `probabilities`.
 *
 * For a distribution it is the top label's probability, so `{ complete: 0.05, not_complete: 0.95 }`
 * is a 0.95-certain `not_complete`, not a 0.05 one. For gates each gate answered yes or no with
 * `max(p, 1 - p)`, and the whole answer is only as certain as its least certain gate: every gate at
 * 0.02 is a confident "load nothing", while one gate at 0.5 makes the set ambiguous. An absent or
 * empty map reports nothing, so it is not an axis.
 */
const chosenProbability = (kind: DecisionKind, probabilities: Record<string, number> | undefined) => {
  const values = Object.values(probabilities ?? {})
  if (values.length === 0) return undefined
  if (PROBABILITY_SHAPE[kind] === "gates") return Math.min(...values.map((p) => Math.max(p, 1 - p)))
  return Math.max(...values)
}

/**
 * A gate passes when every axis the answer actually reports clears its threshold.
 *
 * Both axes are about the answer that was chosen: `confidence` (the weakest of the model's own
 * confidence and the chosen probability) must clear `minConfidence`, and the chosen probability must
 * clear `minProbability`. An absent axis reports nothing, so it is not judged.
 */
const passesGate = (
  confidence: number | undefined,
  probability: number | undefined,
  policy: DecisionPolicy,
): boolean => {
  if (confidence !== undefined && confidence < policy.minConfidence) return false
  if (probability !== undefined && probability < policy.minProbability) return false
  return true
}

export function createDecisionService(deps: {
  repository: DecisionServiceRepository
  config: () => AdaptiveConfig
  egress: EgressGuard
  /** The static model registry; `config.models` assigns one of these ids per kind. */
  models?: readonly PredictiveModel[]
  governor?: Governor
  now?: () => number
}): DecisionService {
  const now = deps.now ?? Date.now
  const governor = deps.governor
  const registry = new Map((deps.models ?? []).map((model) => [model.id, model]))
  if (registry.size !== (deps.models ?? []).length) throw new Error("predictive model ids must be unique")

  /**
   * The model a request may ask, or none. It must be assigned to the kind, registered, and support
   * the kind; the policy must allow a model; and the egress guard must let the model out: a remote
   * model needs its own provider's consent for the project and kind, a local one only the kill switch. Anything short of that is the opt-in posture, not a degradation: the
   * baseline answers and the row says no model was consulted.
   */
  const modelFor = (request: AnyDecisionRequest, config: AdaptiveConfig): PredictiveModel | undefined => {
    const model = registry.get(config.models[request.kind] ?? "")
    if (!model || !model.supports.includes(request.kind) || !allowsModel(request.policy)) return undefined
    if (!deps.egress.allows(model, request.kind, request.projectID)) return undefined
    return model
  }

  /** The model's answer, or the baseline marked degraded with the reason it did not win. */
  const improve = async <Q extends DecisionKind>(
    model: PredictiveModel,
    governor: Governor,
    request: DecisionRequest<Q>,
    baseline: DeterministicBaseline<Q>,
    questions: readonly Question[],
    prepared: PreparedInput,
    mode: PredictionMode,
  ): Promise<Improved<Q>> => {
    const startedAt = now()
    try {
      // The hot path never acquires a limiter slot, so a saturating batch cannot delay a live turn
      // (ADR-0017 §4). Batch stays on the limiter for background work. The hot call is bounded end to
      // end by the request's own timeout: the deadline aborts the model, so a live turn never waits
      // beyond `timeoutMs` even when the model hangs. The mode reaches the model too, so a hot call
      // makes a single attempt and never sleeps on a `Retry-After`.
      const deadline = mode === "hot" ? AbortSignal.timeout(request.policy.timeoutMs) : undefined
      const key = governorKey(request.kind, prepared.hash, model.id)
      const tokens = estimateTokens(prepared.serialized)
      // The answer is read inside the flight, so an unreadable prediction is a `malformed` failure the
      // governor records like any other model fault.
      const work = async (signal: AbortSignal, retry: () => boolean) => {
        const prediction = await model.predict(prepared.state, prepared.questions, {
          deadlineMs: request.policy.timeoutMs,
          signal: deadline ? AbortSignal.any([signal, deadline]) : signal,
          mode,
          retry,
        })
        const reading = readAnswers(request.kind, questions, prediction.answers)
        if (!reading) throw new DecisionUnavailable("malformed")
        return { prediction, reading }
      }
      // The governor records the outcome once per flight, so this caller records nothing: a shared
      // failure seen by several joiners must count once toward the breaker and the limiter.
      const raw = mode === "hot" ? await governor.runHot(key, tokens, work) : await governor.runBatch(key, tokens, work)
      const latencyMs = now() - startedAt
      // Confidence is calibrated here, once, for every model: a model reports its distributions and,
      // optionally, its own confidence in the chosen answer; the recorded confidence is the weakest of
      // the two, so no model can make a confident "no" read as a low-confidence "yes".
      const probabilities = raw.reading.probabilities
      const probability = chosenProbability(request.kind, probabilities)
      const axes = [raw.reading.confidence, probability].filter((axis) => axis !== undefined)
      const confidence = axes.length > 0 ? Math.min(...axes) : undefined
      const version = raw.prediction.model.version
      // The call happened, so what it cost is recorded whether or not its answer clears the gate.
      const reported = {
        ...(confidence !== undefined ? { confidence } : {}),
        ...(probabilities !== undefined ? { probabilities } : {}),
        ...(version !== undefined ? { modelVersion: version, providerVersion: version } : {}),
        providerID: raw.prediction.model.id,
        costUsd: raw.prediction.usage.costUsd,
        inputTokens: raw.prediction.usage.inputTokens,
      }
      if (!passesGate(confidence, probability, request.policy)) {
        return {
          answer: baseline.answer,
          source: "fallback",
          provider: "deterministic",
          attemptedProvider: model.id,
          ...reported,
          latencyMs,
          degraded: true,
          degradedReason: "low-confidence",
        }
      }
      return {
        answer: raw.reading.answer,
        source: "model",
        provider: raw.prediction.model.id,
        attemptedProvider: model.id,
        ...reported,
        latencyMs,
        degraded: false,
      }
    } catch (cause) {
      // The deterministic rule answers whenever the model does not win; the row keeps who was asked
      // (`attemptedProvider`) apart from who answered (`provider`). A call that failed reports no
      // usage, so its cost stays unmeasured rather than zero.
      return {
        answer: baseline.answer,
        source: "fallback",
        provider: "deterministic",
        attemptedProvider: model.id,
        providerID: model.id,
        latencyMs: now() - startedAt,
        degraded: true,
        degradedReason: degradedReasonOf(cause),
      }
    }
  }

  const predict = async <Q extends DecisionKind>(
    request: DecisionRequest<Q>,
    mode: PredictionMode = "batch",
    shadow = true,
  ): Promise<DecisionResult<Q>> => {
    const config = deps.config()
    const baseline = deterministicBaseline(request)
    // A sound widening (`decision.test.ts` proves every `DecisionRequest<Q>` is a member of the union).
    const questions = questionsFor(request)
    const prepared = deps.egress.prepare(request as AnyDecisionRequest, questions)
    const decidedAt = now()
    // The kill switch stops decisions: the deterministic answer is returned and nothing is written.
    if (!config.enabled) {
      return {
        kind: request.kind,
        answer: baseline.answer,
        source: "baseline",
        provider: "deterministic",
        latencyMs: 0,
        degraded: false,
        baseline: baseline.answer,
        baselineRule: baseline.rule,
        inputsHash: prepared.hash,
        decidedAt,
      }
    }

    // Without an eligible model the deterministic answer is the answer, not a degraded one: the
    // harness is exactly as it was before any model existed, which is the opt-in posture.
    const model = modelFor(request as AnyDecisionRequest, config)
    const improved: Improved<Q> =
      model !== undefined && governor !== undefined
        ? await improve(model, governor, request, baseline, questions, prepared, mode)
        : { answer: baseline.answer, source: "baseline", provider: "deterministic", latencyMs: 0, degraded: false }
    const scopeID = request.scopeID ?? request.episodeID ?? request.sessionID ?? request.projectID ?? "unknown"
    // The audit never retains what egress would not let out (ADR-0017 §3): the answer and the
    // baseline go through the same redaction and bound before they reach the writer.
    const input: StoredDecisionInput = {
      id: decisionID(request.kind, scopeID),
      kind: request.kind,
      ...(request.sessionID !== undefined ? { sessionID: request.sessionID } : {}),
      ...(request.episodeID !== undefined ? { episodeID: request.episodeID } : {}),
      ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
      inputsHash: prepared.hash,
      stateSummary: boundSummary(prepared.summary),
      answer: boundAnswer(deps.egress.redact(improved.answer)),
      baselineAnswer: boundAnswer(deps.egress.redact(baseline.answer)),
      baselineRule: baseline.rule,
      ...(improved.confidence !== undefined ? { confidence: improved.confidence } : {}),
      ...(improved.probabilities !== undefined ? { probabilities: improved.probabilities } : {}),
      provider: improved.provider,
      ...(improved.attemptedProvider !== undefined ? { attemptedProvider: improved.attemptedProvider } : {}),
      ...(improved.modelVersion !== undefined ? { modelVersion: improved.modelVersion } : {}),
      source: improved.source,
      ...(improved.providerID !== undefined ? { providerID: improved.providerID } : {}),
      ...(improved.providerVersion !== undefined ? { providerVersion: improved.providerVersion } : {}),
      ...(improved.costUsd !== undefined ? { costUsd: improved.costUsd } : {}),
      ...(improved.inputTokens !== undefined ? { inputTokens: improved.inputTokens } : {}),
      degraded: improved.degraded,
      ...(improved.degradedReason !== undefined ? { degradedReason: improved.degradedReason } : {}),
      latencyMs: improved.latencyMs,
      policy: request.policy,
      shadow,
      ...(request.arm !== undefined ? { arm: request.arm } : {}),
    }
    deps.repository.createDecision(input, decidedAt)

    return {
      kind: request.kind,
      answer: improved.answer,
      source: improved.source,
      provider: improved.provider,
      ...(improved.confidence !== undefined ? { confidence: improved.confidence } : {}),
      ...(improved.probabilities !== undefined ? { probabilities: improved.probabilities } : {}),
      ...(improved.modelVersion !== undefined ? { modelVersion: improved.modelVersion } : {}),
      latencyMs: improved.latencyMs,
      degraded: improved.degraded,
      ...(improved.degradedReason !== undefined ? { degradedReason: improved.degradedReason } : {}),
      baseline: baseline.answer,
      baselineRule: baseline.rule,
      inputsHash: prepared.hash,
      decidedAt,
    }
  }

  /** The sentence `explain` shows: who answered, with what confidence, or why the baseline did. */
  const why = (decision: StoredDecision): string => {
    if (decision.source === "model") {
      const confidence = decision.confidence !== undefined ? ` (confidence ${decision.confidence})` : ""
      return `${decision.providerID ?? decision.provider} ${decision.providerVersion ?? decision.modelVersion ?? "unknown model"} answered${confidence}, clearing the policy thresholds (minConfidence ${decision.policy.minConfidence}, minProbability ${decision.policy.minProbability}).`
    }
    if (decision.source === "baseline") {
      return `The deterministic rule "${decision.baselineRule}" answered; no predictive model was consulted.`
    }
    if (decision.source === "unknown") {
      return `This row records source "${decision.raw?.source ?? ""}", which this build does not recognise; the stored answer is shown as it was recorded.`
    }
    // The row keeps who was asked and who answered apart, so the sentence names the model that could
    // not answer rather than the deterministic rule that did.
    return `The deterministic rule "${decision.baselineRule}" answered because ${decision.providerID ?? decision.attemptedProvider ?? decision.provider} could not: ${decision.degradedReason ?? "unknown"}.`
  }

  const explain = (id: string): DecisionExplanation | undefined => {
    const decision = deps.repository.getDecision(id)
    if (!decision) return undefined
    const episode = decision.episodeID ? deps.repository.getEpisode(decision.episodeID) : undefined
    return {
      id: decision.id,
      question:
        decision.kind === "unknown"
          ? `A decision of kind "${decision.raw?.kind ?? ""}", which this build does not recognise.`
          : QUESTIONS[decision.kind],
      answer: decision.answer,
      baseline: { answer: decision.baselineAnswer, rule: decision.baselineRule },
      why: why(decision),
      source: decision.source,
      provider: decision.provider,
      ...(decision.attemptedProvider !== undefined ? { attemptedProvider: decision.attemptedProvider } : {}),
      ...(decision.modelVersion !== undefined ? { modelVersion: decision.modelVersion } : {}),
      ...(decision.providerID !== undefined ? { providerID: decision.providerID } : {}),
      ...(decision.providerVersion !== undefined ? { providerVersion: decision.providerVersion } : {}),
      ...(decision.costUsd !== undefined ? { costUsd: decision.costUsd } : {}),
      ...(decision.inputTokens !== undefined ? { inputTokens: decision.inputTokens } : {}),
      ...(decision.raw !== undefined ? { raw: decision.raw } : {}),
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.probabilities !== undefined ? { probabilities: decision.probabilities } : {}),
      latencyMs: decision.latencyMs,
      degraded: decision.degraded,
      ...(decision.degradedReason !== undefined ? { degradedReason: decision.degradedReason } : {}),
      ...(decision.episodeID !== undefined ? { episodeID: decision.episodeID } : {}),
      evidenceRefs: episode?.evidenceRefs ?? [],
      decidedAt: decision.createdAt,
    }
  }

  return {
    predict,
    decisions: (filter) => deps.repository.listDecisions(filter),
    explain,
  }
}
