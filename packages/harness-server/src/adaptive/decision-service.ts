/**
 * The decision service: deterministic first, Jev optional, always audited (FH-015).
 *
 * Every decision starts from the deterministic baseline, which is stored even when an external
 * provider wins so `explain` never re-executes and never spends. The service applies the thresholds
 * (they live in `DecisionPolicy`, not in the adapter), records a redacted summary and the baseline,
 * and degrades to the baseline with a reason whenever Jev cannot answer.
 *
 * `explain` is built only from the stored row and the episode it points at — no provider is called,
 * which is what makes the answer reproducible.
 */

import type {
  AnyDecisionRequest,
  DecisionKind,
  DecisionRequest,
  DecisionResult,
  DecisionSource,
  DecisionSpec,
  DegradedReason,
} from "./decision"
import type { AdaptiveConfig } from "./config"
import { estimateTokens } from "./context"
import type { EgressGuard } from "./egress"
import { boundAnswer, boundSummary, decisionID } from "./decision-record"
import { deterministicBaseline } from "./providers/deterministic"
import type { DeterministicBaseline } from "./providers/deterministic"
import { degradedReasonOf } from "./providers/provider"
import type { DecisionProvider } from "./providers/provider"
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
  source: DecisionSource
  provider: string
  /** The external provider that was asked, when one was, even if it could not answer. */
  attemptedProvider?: string
  modelVersion?: string
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
 * the request's `timeoutMs`, so a live turn cannot wait for Jev because a background batch saturates
 * the limiter. `batch` is the default for background work (the shadow), which goes through the
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

/** What the external attempt yields, before the deterministic baseline is folded back in. */
type Improved<Q extends DecisionKind> = {
  answer: DecisionSpec[Q]["answer"]
  source: DecisionSource
  provider: string
  attemptedProvider?: string
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
 * The probability of the answer actually chosen, read from the provider's `probabilities`.
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
 * Both axes are about the answer that was chosen: `confidence` (the weakest of the provider's own
 * confidence and the chosen probability) must clear `minConfidence`, and the chosen probability must
 * clear `minProbability`. An absent axis reports nothing, so it is not judged.
 */
const passesGate = (
  confidence: number | undefined,
  probability: number | undefined,
  minConfidence: number,
  minProbability: number,
): boolean => {
  if (confidence !== undefined && confidence < minConfidence) return false
  if (probability !== undefined && probability < minProbability) return false
  return true
}

export function createDecisionService(deps: {
  repository: DecisionServiceRepository
  config: () => AdaptiveConfig
  egress: EgressGuard
  external?: DecisionProvider
  governor?: Governor
  now?: () => number
}): DecisionService {
  const now = deps.now ?? Date.now
  const external = deps.external
  const governor = deps.governor

  /** The external answer, or the baseline marked degraded with the reason it did not win. */
  const improve = async <Q extends DecisionKind>(
    provider: DecisionProvider,
    governor: Governor,
    request: DecisionRequest<Q>,
    config: AdaptiveConfig,
    baseline: DeterministicBaseline<Q>,
    body: string,
    hash: string,
    mode: PredictionMode,
  ): Promise<Improved<Q>> => {
    const startedAt = now()
    // The deterministic rule answers whenever the external provider does not win; the row keeps who
    // was asked (`attemptedProvider`) apart from who answered (`provider`).
    const degrade = (reason: DegradedReason, latencyMs: number, attemptedProvider: string): Improved<Q> => ({
      answer: baseline.answer,
      source: "fallback",
      provider: "deterministic",
      attemptedProvider,
      latencyMs,
      degraded: true,
      degradedReason: reason,
    })
    try {
      // The hot path never acquires a limiter slot, so a saturating batch cannot delay a live turn
      // (ADR-0017 §4). Batch stays on the limiter for background work. The hot call is bounded end to
      // end by the request's own timeout: the deadline aborts the provider, so a live turn never waits
      // for Jev beyond `timeoutMs` even when the provider hangs. The mode reaches the provider too, so a
      // hot call makes a single attempt and never sleeps on a `Retry-After`.
      const deadline = mode === "hot" ? AbortSignal.timeout(request.policy.timeoutMs) : undefined
      const key = governorKey(request.kind, hash, config.jev.model)
      const tokens = estimateTokens(body)
      const work = (signal: AbortSignal, retry: () => boolean) =>
        provider.answer(request, deadline ? AbortSignal.any([signal, deadline]) : signal, { mode, retry })
      // The governor records the outcome once per flight, so this caller records nothing: a shared
      // failure seen by several joiners must count once toward the breaker and the limiter.
      const raw = mode === "hot" ? await governor.runHot(key, tokens, work) : await governor.runBatch(key, tokens, work)
      // A wrapping provider (the FH-013 fallback) already exhausted its retries and handed back the
      // deterministic answer. Honor its outcome instead of relabelling it as a Jev win.
      if (raw.degraded)
        return degrade(raw.degradedReason ?? "network", raw.latencyMs ?? now() - startedAt, raw.attemptedProvider ?? provider.id)
      const latencyMs = now() - startedAt
      // Confidence is calibrated here, once, for every provider: a provider reports its probabilities
      // and, optionally, its own confidence in the chosen answer; the recorded confidence is the
      // weakest of the two, so no adapter can make a confident "no" read as a low-confidence "yes".
      const probability = chosenProbability(request.kind, raw.probabilities)
      const axes = [raw.confidence, probability].filter((axis) => axis !== undefined)
      const confidence = axes.length > 0 ? Math.min(...axes) : undefined
      if (!passesGate(confidence, probability, request.policy.minConfidence, request.policy.minProbability)) {
        return {
          answer: baseline.answer,
          source: "fallback",
          provider: "deterministic",
          attemptedProvider: raw.attemptedProvider ?? provider.id,
          ...(confidence !== undefined ? { confidence } : {}),
          ...(raw.probabilities !== undefined ? { probabilities: raw.probabilities } : {}),
          ...(raw.modelVersion !== undefined ? { modelVersion: raw.modelVersion } : {}),
          latencyMs,
          degraded: true,
          degradedReason: "low-confidence",
        }
      }
      return {
        answer: raw.answer,
        source: "jev",
        provider: raw.provider ?? provider.id,
        attemptedProvider: raw.attemptedProvider ?? provider.id,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(raw.probabilities !== undefined ? { probabilities: raw.probabilities } : {}),
        ...(raw.modelVersion !== undefined ? { modelVersion: raw.modelVersion } : {}),
        latencyMs,
        degraded: false,
      }
    } catch (cause) {
      return degrade(degradedReasonOf(cause), now() - startedAt, provider.id)
    }
  }

  const predict = async <Q extends DecisionKind>(
    request: DecisionRequest<Q>,
    mode: PredictionMode = "batch",
    shadow = true,
  ): Promise<DecisionResult<Q>> => {
    const config = deps.config()
    const baseline = deterministicBaseline(request)
    const prepared = deps.egress.prepare(request as AnyDecisionRequest)
    const decidedAt = now()
    // The kill switch stops decisions: the deterministic answer is returned and nothing is written.
    if (!config.enabled) {
      return {
        kind: request.kind,
        answer: baseline.answer,
        source: "deterministic",
        provider: "deterministic",
        latencyMs: 0,
        degraded: false,
        baseline: baseline.answer,
        baselineRule: baseline.rule,
        inputsHash: prepared.hash,
        decidedAt,
      }
    }

    // Jev is attempted only when it is enabled and this project and kind are allowlisted. Otherwise
    // the deterministic answer is the answer, not a degraded one: the harness is exactly as it was
    // before Jev existed, which is the opt-in posture.
    const mayAttempt =
      request.policy.allowJev && config.jev.enabled && deps.egress.allows(request.kind, request.projectID)
    const improved: Improved<Q> =
      external !== undefined && governor !== undefined && mayAttempt
        ? await improve(external, governor, request, config, baseline, prepared.body, prepared.hash, mode)
        : { answer: baseline.answer, source: "deterministic", provider: "deterministic", latencyMs: 0, degraded: false }
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
      degraded: improved.degraded,
      ...(improved.degradedReason !== undefined ? { degradedReason: improved.degradedReason } : {}),
      latencyMs: improved.latencyMs,
      policy: request.policy,
      shadow,
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
    if (decision.source === "jev") {
      const confidence = decision.confidence !== undefined ? ` (confidence ${decision.confidence})` : ""
      return `${decision.provider} ${decision.modelVersion ?? "unknown model"} answered${confidence}, clearing the policy thresholds (minConfidence ${decision.policy.minConfidence}, minProbability ${decision.policy.minProbability}).`
    }
    if (decision.source === "deterministic") {
      return `The deterministic rule "${decision.baselineRule}" answered; no external provider was consulted.`
    }
    // The row keeps who was asked and who answered apart, so the sentence names the provider that
    // could not answer rather than the deterministic rule that did.
    return `The deterministic rule "${decision.baselineRule}" answered because ${decision.attemptedProvider ?? decision.provider} could not: ${decision.degradedReason ?? "unknown"}.`
  }

  const explain = (id: string): DecisionExplanation | undefined => {
    const decision = deps.repository.getDecision(id)
    if (!decision) return undefined
    const episode = decision.episodeID ? deps.repository.getEpisode(decision.episodeID) : undefined
    return {
      id: decision.id,
      question: QUESTIONS[decision.kind],
      answer: decision.answer,
      baseline: { answer: decision.baselineAnswer, rule: decision.baselineRule },
      why: why(decision),
      source: decision.source,
      provider: decision.provider,
      ...(decision.attemptedProvider !== undefined ? { attemptedProvider: decision.attemptedProvider } : {}),
      ...(decision.modelVersion !== undefined ? { modelVersion: decision.modelVersion } : {}),
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
