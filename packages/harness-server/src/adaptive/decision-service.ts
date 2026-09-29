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
import { DecisionUnavailable } from "./providers/provider"
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
 * A gate passes when every axis the answer actually reports clears its threshold.
 *
 * An absent confidence, or a probability map with no entries, is **not an axis**: nothing was
 * reported, so nothing is judged, and the gate passes. When probabilities are present the axis is the
 * **top** (winning) label's probability — the maximum, not the minimum, because the entries of a
 * distribution cannot all sit above a threshold — and `minProbability` is the floor it must clear.
 * `minConfidence` applies to the provider's single overall confidence, independently.
 */
const passesGate = (
  confidence: number | undefined,
  probabilities: Record<string, number> | undefined,
  minConfidence: number,
  minProbability: number,
): boolean => {
  if (confidence !== undefined && confidence < minConfidence) return false
  const topProbability =
    probabilities && Object.keys(probabilities).length > 0 ? Math.max(...Object.values(probabilities)) : undefined
  if (topProbability !== undefined && topProbability < minProbability) return false
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
      // for Jev beyond `timeoutMs` even when the provider hangs.
      const deadline = mode === "hot" ? AbortSignal.timeout(request.policy.timeoutMs) : undefined
      const key = governorKey(request.kind, hash, config.jev.model)
      const tokens = estimateTokens(body)
      const work = (signal: AbortSignal) => provider.answer(request, deadline ? AbortSignal.any([signal, deadline]) : signal)
      const raw = mode === "hot" ? await governor.runHot(key, tokens, work) : await governor.runBatch(key, tokens, work)
      // A wrapping provider (the FH-013 fallback) already exhausted its retries and handed back the
      // deterministic answer. Honor its outcome instead of relabelling it as a Jev win.
      if (raw.degraded) {
        const reason = raw.degradedReason ?? "network"
        governor.recordFailure(reason)
        if (reason === "rate-limited") governor.recordRateLimit()
        return degrade(reason, raw.latencyMs ?? now() - startedAt, raw.attemptedProvider ?? provider.id)
      }
      governor.recordSuccess()
      const latencyMs = now() - startedAt
      if (!passesGate(raw.confidence, raw.probabilities, request.policy.minConfidence, request.policy.minProbability)) {
        return {
          answer: baseline.answer,
          source: "fallback",
          provider: "deterministic",
          attemptedProvider: raw.attemptedProvider ?? provider.id,
          ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
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
        ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
        ...(raw.probabilities !== undefined ? { probabilities: raw.probabilities } : {}),
        ...(raw.modelVersion !== undefined ? { modelVersion: raw.modelVersion } : {}),
        latencyMs,
        degraded: false,
      }
    } catch (cause) {
      // An aborted deadline is a timeout, not a network fault: the hot path must record the reason it
      // actually degraded for.
      const reason =
        cause instanceof DecisionUnavailable
          ? cause.reason
          : cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
            ? "timeout"
            : "network"
      governor.recordFailure(reason)
      // A 429 is a 429: the limiter backs off whether or not the provider named a `Retry-After`.
      if (reason === "rate-limited")
        governor.recordRateLimit(cause instanceof DecisionUnavailable ? cause.retryAfterMs : undefined)
      return degrade(reason, now() - startedAt, provider.id)
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
