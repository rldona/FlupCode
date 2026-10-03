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

import { allowsModel, isDecisionKind } from "./decision"
import type { DecisionPolicy, DecisionSource, DecisionSpec, DegradedReason, SpecRequest, SpecResult } from "./decision"
import type { AdaptiveConfig } from "./config"
import { estimateTokens } from "./context"
import type { EgressGuard, PreparedInput } from "./egress"
import { boundAnswer, boundSummary, decisionID } from "./decision-record"
import { readWith } from "./questions"
import type { DecisionDefinition, DecisionRegistry, KindOf, KindSpec } from "./decisions/define"
import { DECISIONS } from "./decisions/registry"
import { canAnswer } from "./predictive/model"
import type { PredictiveModel, Question } from "./predictive/model"
import { DecisionUnavailable, degradedReasonOf } from "./providers/provider"
import { governorKey } from "./providers/governor"
import type { Governor } from "./providers/governor"
import type { ValueGate } from "./value-gate"
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
  /** The outcome label (AH-C06), once the labeler judged it. */
  label?: StoredDecision["label"]
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

export type DecisionService<S extends KindSpec = DecisionSpec> = {
  /**
   * `shadow` marks the audit row: `true` (the default) records a decision the harness does not act
   * on, which is every episode decision; an acting path — the relevance line — passes `false`. The
   * default keeps the Phase 2/3a/3b shadow byte-identical when no flag is given.
   */
  predict<Q extends KindOf<S>>(
    request: SpecRequest<S, Q>,
    mode?: PredictionMode,
    shadow?: boolean,
  ): Promise<SpecResult<S, Q>>
  decisions(filter?: DecisionFilter): StoredDecision[]
  explain(id: string): DecisionExplanation | undefined
}

/** What the model attempt yields, before the deterministic baseline is folded back in. */
type Improved<A> = {
  answer: A
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

/** One kind's definition and baseline, in the spec a service answers. */
type KindDefinition<S extends KindSpec, Q extends KindOf<S>> = DecisionDefinition<Q, S[Q]["state"], S[Q]["answer"]>
type KindBaseline<S extends KindSpec, Q extends KindOf<S>> = { answer: S[Q]["answer"]; rule: string }

/** Why the value-of-information gate (AH-C05) did not consult the assigned model, as `explain` says it. */
const GATE_SKIPS: Partial<Record<DegradedReason, string>> = {
  "voi-paused": "the predictive model does not improve this decision, so the value-of-information gate paused it",
  "voi-below-cost": "the predictive model's expected value does not cover its cost and latency",
  "p95-over-deadline": "the predictive model's measured p95 latency exceeds this decision's deadline",
  "session-paused": "the adaptive layer is paused in this session, so the decision was recorded and nothing acted on it",
}

/**
 * The probability of the answer actually chosen, read from the answer's `probabilities`.
 *
 * For a distribution it is the top label's probability, so `{ complete: 0.05, not_complete: 0.95 }`
 * is a 0.95-certain `not_complete`, not a 0.05 one. For gates each gate answered yes or no with
 * `max(p, 1 - p)`, and the whole answer is only as certain as its least certain gate: every gate at
 * 0.02 is a confident "load nothing", while one gate at 0.5 makes the set ambiguous. An absent or
 * empty map reports nothing, so it is not an axis. What the map means is the kind's own declaration.
 */
const chosenProbability = (
  shape: DecisionDefinition<string, never, unknown>["probabilities"],
  probabilities: Record<string, number> | undefined,
) => {
  const values = Object.values(probabilities ?? {})
  if (values.length === 0) return undefined
  if (shape === "gates") return Math.min(...values.map((p) => Math.max(p, 1 - p)))
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

export function createDecisionService<S extends KindSpec = DecisionSpec>(deps: {
  repository: DecisionServiceRepository
  config: () => AdaptiveConfig
  egress: EgressGuard<S>
  /** The decision kinds it answers (PI-02); the server's own registry unless a caller brings one. */
  decisions?: DecisionRegistry<S>
  /** The static model registry; `config.models` assigns one of these ids per kind. */
  models?: readonly PredictiveModel[]
  governor?: Governor
  /** The value-of-information gate and answer cache (AH-C05); without one every eligible model is asked. */
  valueGate?: ValueGate
  /** The session override (AH-E02): a paused session asks no model and records a row that did not act. */
  paused?: (sessionID: string) => boolean
  now?: () => number
}): DecisionService<S> {
  const now = deps.now ?? Date.now
  // Without a registry of its own the service answers the server's kinds, which is the spec `S`
  // defaults to; only a caller that brings a registry names another spec.
  const decisions = deps.decisions ?? (DECISIONS as unknown as DecisionRegistry<S>)
  type Kind<Q extends KindOf<S>> = KindDefinition<S, Q>
  type Baseline<Q extends KindOf<S>> = KindBaseline<S, Q>
  const governor = deps.governor
  const registry = new Map((deps.models ?? []).map((model) => [model.id, model]))
  if (registry.size !== (deps.models ?? []).length) throw new Error("predictive model ids must be unique")

  /**
   * The model a request may ask, or none. It must be assigned to the kind, registered, and able to
   * answer the kind (`canAnswer`: its capability, latency class and, when it lists them, its kinds);
   * the policy must allow a model; and the egress guard must let the model out: a remote
   * model needs its own provider's consent for the project and kind, a local one only the kill switch. Anything short of that is the opt-in posture, not a degradation: the
   * baseline answers and the row says no model was consulted.
   */
  const modelFor = <Q extends KindOf<S>>(
    request: SpecRequest<S, Q>,
    definition: Kind<Q>,
    config: AdaptiveConfig,
  ): PredictiveModel | undefined => {
    const model = registry.get(config.models[request.kind] ?? "")
    if (!model || !canAnswer(model, definition) || !allowsModel(request.policy)) return undefined
    if (!deps.egress.allows(model, request.kind, request.projectID)) return undefined
    return model
  }

  /** The model's answer, or the baseline marked degraded with the reason it did not win. */
  const improve = async <Q extends KindOf<S>>(
    model: PredictiveModel,
    governor: Governor,
    request: SpecRequest<S, Q>,
    definition: Kind<Q>,
    baseline: Baseline<Q>,
    questions: readonly Question[],
    prepared: PreparedInput,
    mode: PredictionMode,
  ): Promise<Improved<S[Q]["answer"]>> => {
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
        const reading = readWith(definition, questions, prediction.answers)
        if (!reading) throw new DecisionUnavailable("malformed")
        return { prediction, reading }
      }
      // The governor records the outcome once per flight, so this caller records nothing: a shared
      // failure seen by several joiners must count once toward the breaker and the limiter.
      // The provider's own budget (PI-01) lowers the month's limit for it alone.
      const providers = deps.config().providers
      const cap = Object.hasOwn(providers, model.id) ? providers[model.id]?.budget?.monthlyTokens : undefined
      const raw =
        mode === "hot" ? await governor.runHot(key, tokens, work, cap) : await governor.runBatch(key, tokens, work, cap)
      const latencyMs = now() - startedAt
      // Confidence is calibrated here, once, for every model: a model reports its distributions and,
      // optionally, its own confidence in the chosen answer; the recorded confidence is the weakest of
      // the two, so no model can make a confident "no" read as a low-confidence "yes".
      const probabilities = raw.reading.probabilities
      const probability = chosenProbability(definition.probabilities, probabilities)
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

  /**
   * The model's answer through the value-of-information gate (AH-C05). A cached answer from the same
   * model version for the same prepared input is reused when it still clears the policy; otherwise the
   * gate decides whether the model is worth asking. A skipped model is not consulted at all: the row
   * keeps `source: "baseline"` and no provider, so it never feeds the stats it was gated by.
   */
  const consult = async <Q extends KindOf<S>>(
    model: PredictiveModel,
    governor: Governor,
    request: SpecRequest<S, Q>,
    definition: Kind<Q>,
    baseline: Baseline<Q>,
    questions: readonly Question[],
    prepared: PreparedInput,
    mode: PredictionMode,
    scopeID: string,
  ): Promise<Improved<S[Q]["answer"]>> => {
    const gate = deps.valueGate
    // The gate's statistics and per-kind weights are the configured kinds' (`voi.kinds`); a kind a
    // caller registered beyond them is asked without the gate.
    const kind = request.kind
    if (!gate || !isDecisionKind(kind)) {
      return improve(model, governor, request, definition, baseline, questions, prepared, mode)
    }
    const cached = gate.recall(kind, model.id, prepared.hash)
    if (
      cached &&
      passesGate(cached.confidence, chosenProbability(definition.probabilities, cached.probabilities), request.policy)
    ) {
      return {
        // The cache key carries the kind, so the answer was read for this kind's shape.
        answer: cached.answer as S[Q]["answer"],
        source: "model",
        provider: cached.providerID,
        attemptedProvider: model.id,
        providerID: cached.providerID,
        ...(cached.version !== undefined ? { modelVersion: cached.version, providerVersion: cached.version } : {}),
        ...(cached.confidence !== undefined ? { confidence: cached.confidence } : {}),
        ...(cached.probabilities !== undefined ? { probabilities: cached.probabilities } : {}),
        // Nothing was spent: no cost is recorded, so the cost and latency estimates stay on real calls.
        latencyMs: 0,
        degraded: false,
      }
    }
    const verdict = gate.verdict({
      kind,
      modelID: model.id,
      scopeID,
      ...(mode === "hot" ? { deadlineMs: request.policy.timeoutMs } : {}),
    })
    if (!verdict.ask) {
      return {
        answer: baseline.answer,
        source: "baseline",
        provider: "deterministic",
        latencyMs: 0,
        degraded: true,
        degradedReason: verdict.reason,
      }
    }
    const improved = await improve(model, governor, request, definition, baseline, questions, prepared, mode)
    if (improved.source === "model") {
      gate.remember(kind, model.id, prepared.hash, {
        answer: improved.answer,
        providerID: improved.providerID ?? model.id,
        ...(improved.providerVersion !== undefined ? { version: improved.providerVersion } : {}),
        ...(improved.confidence !== undefined ? { confidence: improved.confidence } : {}),
        ...(improved.probabilities !== undefined ? { probabilities: improved.probabilities } : {}),
      })
    }
    return improved
  }

  const predict = async <Q extends KindOf<S>>(
    request: SpecRequest<S, Q>,
    mode: PredictionMode = "batch",
    shadow = true,
  ): Promise<SpecResult<S, Q>> => {
    const config = deps.config()
    const definition = decisions.get(request.kind)
    const baseline = definition.baseline(request)
    const questions = definition.questions(request.state)
    const prepared = deps.egress.prepare(request, questions)
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

    // A paused session (AH-E02) still records the decision, so the audit says why nothing acted, but
    // asks no model and marks the row as not acting whatever the caller asked for.
    const paused = request.sessionID !== undefined && deps.paused?.(request.sessionID) === true
    // Without an eligible model the deterministic answer is the answer, not a degraded one: the
    // harness is exactly as it was before any model existed, which is the opt-in posture.
    const model = paused ? undefined : modelFor(request, definition, config)
    const scopeID = request.scopeID ?? request.episodeID ?? request.sessionID ?? request.projectID ?? "unknown"
    const improved: Improved<S[Q]["answer"]> = paused
      ? {
          answer: baseline.answer,
          source: "baseline",
          provider: "deterministic",
          latencyMs: 0,
          degraded: true,
          degradedReason: "session-paused",
        }
      : model !== undefined && governor !== undefined
        ? await consult(model, governor, request, definition, baseline, questions, prepared, mode, scopeID)
        : { answer: baseline.answer, source: "baseline", provider: "deterministic", latencyMs: 0, degraded: false }
    // The audit never retains what egress would not let out (ADR-0017 §3): the answer and the
    // baseline go through the same redaction and bound before they reach the writer.
    const input: StoredDecisionInput<string> = {
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
      shadow: shadow || paused,
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
      const skipped = decision.degradedReason !== undefined ? GATE_SKIPS[decision.degradedReason] : undefined
      if (skipped) return `The deterministic rule "${decision.baselineRule}" answered; no predictive model was consulted: ${skipped}.`
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
    // A row reads its kind through the server's kinds; one a caller registered reads back `unknown`
    // with its name in `raw`, and its own registry still knows the question.
    const kind = decision.kind === "unknown" ? decision.raw?.kind : decision.kind
    return {
      id: decision.id,
      question: decisions.has(kind)
        ? decisions.get(kind).question
        : `A decision of kind "${decision.raw?.kind ?? ""}", which this build does not recognise.`,
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
      ...(decision.label !== undefined ? { label: decision.label } : {}),
    }
  }

  return {
    predict,
    decisions: (filter) => deps.repository.listDecisions(filter),
    explain,
  }
}
