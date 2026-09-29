/**
 * The failure/loop guardrail service (FH-060–063, ADR-0023).
 *
 * It owns the per-session rings of opaque observations and the one policy point behind the advisory
 * verdict: with the feature off or off-legacy it returns `continue` before touching a ring and writes
 * nothing; below the thresholds it only accumulates; on a detected loop it runs the `failure` and
 * `toolRisk` decisions hot and `shadow: false` and returns an advisory result. It never pauses a turn.
 *
 * The state is in memory and bounded: a ring per session (window and count) and a deterministic
 * decision cache, so a loop that persists neither re-spends Jev nor rewrites its audit row. A restart
 * forgets both, which is the deliberate price of not storing per-observation state.
 */

import type { AdaptiveConfig } from "./config"
import type { DecisionRequest, DecisionSource, FailureAnswer, ToolRisk } from "./decision"
import type { DecisionService } from "./decision-service"
import { decisionID } from "./decision-record"
import { appendObservation, detectLoop, failureState } from "./guardrails-detector"
import type { LoopObservation, RingEntry } from "./guardrails-detector"
import { elevateRisk } from "./risk"
import type { RiskLevel } from "./risk"
import type { RuntimeCapabilities } from "./runtime"

export type GuardrailReason = "disabled" | "runtime-not-legacy" | "below-threshold" | "loop" | "error"

export type GuardrailResult = {
  verdict: FailureAnswer["verdict"]
  reason: GuardrailReason
  repeatedCalls: number
  repeatedErrors: number
  steps: "unsupported"
  decisionID?: string
  source?: DecisionSource
  degraded?: boolean
  risk?: { risk: ToolRisk; raiseOnly: true }
  latencyMs: number
}

/**
 * The live advisory a browser reads (FH-062, ADR-0023 §2). It is opaque: a reason, the counts, the
 * tool name and the deterministic `decisionID`, plus the cached `risk`. It carries no argument, no
 * message and no tool output, and it is derived from the same ring the detector writes.
 */
export type GuardrailStatus = {
  reason: "loop" | "error"
  repeatedCalls: number
  repeatedErrors: number
  tool?: string
  decisionID: string
  risk?: ToolRisk
  at: number
}

export type GuardrailService = {
  observe(input: { projectID: string; sessionID: string; observation: LoopObservation }): Promise<GuardrailResult>
  /** The read-only projection of the session's ring; `null` when no threshold is crossed. */
  status(sessionID: string): GuardrailStatus | null
}

/** Writes into a bounded LRU: the newest key is last, the oldest is evicted past the cap. */
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function createGuardrailService(deps: {
  service: DecisionService
  runtimeProbe: { capabilities(): RuntimeCapabilities }
  config: () => AdaptiveConfig
  now?: () => number
}): GuardrailService {
  const now = deps.now ?? Date.now
  const rings = new Map<string, RingEntry[]>()
  const decisions = new Map<string, { at: number; result: GuardrailResult }>()

  const inert = (reason: GuardrailReason, startedAt: number): GuardrailResult => ({
    verdict: "continue",
    reason,
    repeatedCalls: 0,
    repeatedErrors: 0,
    steps: "unsupported",
    latencyMs: now() - startedAt,
  })

  const observe = async (input: {
    projectID: string
    sessionID: string
    observation: LoopObservation
  }): Promise<GuardrailResult> => {
    const startedAt = now()
    const config = deps.config()
    // The gate is first and touches no state: with the feature off no ring is read or written and no
    // row can follow (ADR-0023 §6). Off-legacy the plugin's hooks do not fire either, so the same.
    if (!config.enabled || !config.guardrails.enabled) return inert("disabled", startedAt)
    if (!deps.runtimeProbe.capabilities().canObserveToolCalls) return inert("runtime-not-legacy", startedAt)

    const ring = rings.get(input.sessionID) ?? []
    const updated = appendObservation(ring, input.observation, startedAt, {
      windowMs: config.guardrails.windowMs,
      maxObservations: config.guardrails.maxObservations,
    })
    remember(rings, input.sessionID, updated, config.guardrails.maxSessions)

    const signal = detectLoop(updated)
    const repeatedCalls = signal.repeatedCalls
    const repeatedErrors = signal.repeatedErrors
    const callsCrossed = repeatedCalls >= config.guardrails.repeatedCalls
    const errorsCrossed = repeatedErrors >= config.guardrails.repeatedErrors
    // Below the thresholds it is only accumulation: no decision is asked and no row is written.
    if (!callsCrossed && !errorsCrossed) {
      return { verdict: "continue", reason: "below-threshold", repeatedCalls, repeatedErrors, steps: "unsupported", latencyMs: now() - startedAt }
    }

    // The deterministic id names the loop: the same tool and digest converge on one row, and the
    // cache keeps a persistent loop from re-spending Jev or rewriting it (ADR-0023 §6).
    const digest = signal.argsDigest ?? signal.errorDigest ?? "none"
    const scopeID = `${input.sessionID}:${signal.tool ?? "tool"}:${digest}`
    const id = decisionID("failure", scopeID)
    const cached = decisions.get(id)
    if (cached && now() - cached.at < config.guardrails.windowMs) {
      remember(decisions, id, cached, config.guardrails.maxSessions)
      // The decision is reused; only the counts and the latency are recomposed from this observation.
      return { ...cached.result, repeatedCalls, repeatedErrors, latencyMs: now() - startedAt }
    }

    const reason: GuardrailReason = callsCrossed ? "loop" : "error"
    const failureRequest: DecisionRequest<"failure"> = {
      kind: "failure",
      state: failureState(signal),
      policy: { ...config.decisions.failure, timeoutMs: config.guardrails.timeoutMs },
      scopeID,
      sessionID: input.sessionID,
      projectID: input.projectID,
    }
    const failure = await deps.service.predict(failureRequest, "hot", false)

    // The native floor is unknown until a permission seam exists, so the learned score starts from
    // `ALLOW`; `elevateRisk` still caps it and never lets a learned score reach `DENY` (ADR-0023 §5).
    const native: RiskLevel = "ALLOW"
    const toolRiskRequest: DecisionRequest<"toolRisk"> = {
      kind: "toolRisk",
      state: { tool: signal.tool ?? "tool", argsDigest: signal.argsDigest ?? digest },
      policy: { ...config.decisions.toolRisk, timeoutMs: config.guardrails.timeoutMs },
      scopeID,
      sessionID: input.sessionID,
      projectID: input.projectID,
    }
    const toolRisk = await deps.service.predict(toolRiskRequest, "hot", false)
    const risk = elevateRisk(native, toolRisk.answer.risk)

    const result: GuardrailResult = {
      verdict: failure.answer.verdict,
      reason,
      repeatedCalls,
      repeatedErrors,
      steps: "unsupported",
      decisionID: id,
      source: failure.source,
      degraded: failure.degraded,
      risk: { risk, raiseOnly: true },
      latencyMs: now() - startedAt,
    }
    remember(decisions, id, { at: now(), result }, config.guardrails.maxSessions)
    return result
  }

  // The read-only projection of the same ring (FH-062, ADR-0023 §6): the same gate, the same window
  // and the same thresholds, the deterministic id and the cached risk. It never mutates the ring or
  // writes a row, so when the streak breaks or the window drops the entries it projects nothing.
  const status = (sessionID: string): GuardrailStatus | null => {
    const config = deps.config()
    if (!config.enabled || !config.guardrails.enabled) return null
    if (!deps.runtimeProbe.capabilities().canObserveToolCalls) return null
    const ring = rings.get(sessionID)
    if (ring === undefined) return null
    const current = now()
    const fresh = ring.filter((entry) => current - entry.at < config.guardrails.windowMs)
    const signal = detectLoop(fresh)
    const callsCrossed = signal.repeatedCalls >= config.guardrails.repeatedCalls
    const errorsCrossed = signal.repeatedErrors >= config.guardrails.repeatedErrors
    if (!callsCrossed && !errorsCrossed) return null
    const digest = signal.argsDigest ?? signal.errorDigest ?? "none"
    const id = decisionID("failure", `${sessionID}:${signal.tool ?? "tool"}:${digest}`)
    const cached = decisions.get(id)
    const risk = cached && current - cached.at < config.guardrails.windowMs ? cached.result.risk?.risk : undefined
    return {
      reason: callsCrossed ? "loop" : "error",
      repeatedCalls: signal.repeatedCalls,
      repeatedErrors: signal.repeatedErrors,
      ...(signal.tool !== undefined ? { tool: signal.tool } : {}),
      decisionID: id,
      ...(risk !== undefined ? { risk } : {}),
      at: fresh[fresh.length - 1]?.at ?? current,
    }
  }

  return { observe, status }
}
