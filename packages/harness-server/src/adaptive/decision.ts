/**
 * Typed decisions the adaptive layer can ask (FH-010).
 *
 * A decision is a question about the session the harness is observing — is this episode complete,
 * which skills matter for this objective, what should happen to this context item — and a typed
 * answer to it. The seven kinds are declared here even though only three carry rich deterministic
 * logic in this phase, so the seam, the audit and the provider dispatch are all exhaustive: adding a
 * kind to `DecisionSpec` does not compile until every map below lists it.
 *
 * This module is the domain and nothing else: no provider, no network, no Jev. It is also the only
 * place that reads a decision's answer out of untrusted data, always falling back to a safe value
 * rather than to a guess (the same defensive style `episode.ts` uses).
 */

import { createHash } from "node:crypto"
import type { EpisodeOutcome } from "./episode"

// ---- answers per kind ------------------------------------------------------------------------

export const ITEM_DISPOSITIONS = ["keep", "archive", "drop"] as const
export type ItemDisposition = (typeof ITEM_DISPOSITIONS)[number]

export const DECISION_TIERS = ["CHEAP", "BALANCED", "HIGH", "MAX"] as const
export type DecisionTier = (typeof DECISION_TIERS)[number]

export const AGENT_ROUTES = ["CONTINUE", "REVIEW", "DEBUG", "ARCHITECT", "ASK_USER"] as const
export type AgentRoute = (typeof AGENT_ROUTES)[number]

export const TOOL_RISKS = ["ALLOW", "CONFIRM", "REVIEW", "DENY"] as const
export type ToolRisk = (typeof TOOL_RISKS)[number]

export type CompletionAnswer = { verdict: "complete" | "not_complete" }
export type SkillRelevanceAnswer = { load: string[] }
export type ContextItemAnswer = { decisions: Array<{ id: string; disposition: ItemDisposition }> }
export type ModelRouteAnswer = { tier: DecisionTier }
export type AgentRouteAnswer = { agent: AgentRoute }
export type ToolRiskAnswer = { risk: ToolRisk }
export type FailureAnswer = { verdict: "continue" | "intervene" }

// ---- states per kind (bounded; never a session's raw state) ----------------------------------

export type CompletionState = {
  episodeID: string
  objective: string
  outcome: EpisodeOutcome
  toolCalls: number
  verifications: Array<{ step: string; ok: boolean }>
  failures: number
  projectID: string
}
export type SkillRelevanceState = {
  sessionID: string
  objective: string
  skills: Array<{ name: string; description: string; learned: boolean }>
}
export type ContextItemState = {
  objective: string
  items: Array<{ id: string; kind: string; tokens: number; referenced: boolean }>
}
export type ModelRouteState = { role: string; taskName: string; declared?: string }
export type AgentRouteState = { objective: string; signals: string[] }
export type ToolRiskState = { tool: string; argsDigest: string }
export type FailureState = {
  repeatedCalls: number
  repeatedErrors: number
  stepsUsed: number
  stepsBudget?: number
}

/** The map that defines the seven kinds and correlates each state with its answer. */
export type DecisionSpec = {
  completion: { state: CompletionState; answer: CompletionAnswer }
  skillRelevance: { state: SkillRelevanceState; answer: SkillRelevanceAnswer }
  contextItem: { state: ContextItemState; answer: ContextItemAnswer }
  modelRoute: { state: ModelRouteState; answer: ModelRouteAnswer }
  agentRoute: { state: AgentRouteState; answer: AgentRouteAnswer }
  toolRisk: { state: ToolRiskState; answer: ToolRiskAnswer }
  failure: { state: FailureState; answer: FailureAnswer }
}

export type DecisionKind = keyof DecisionSpec

/** Total record: adding a kind to `DecisionSpec` does not compile until it is listed here. */
export const DECISION_KINDS: Record<DecisionKind, true> = {
  completion: true,
  skillRelevance: true,
  contextItem: true,
  modelRoute: true,
  agentRoute: true,
  toolRisk: true,
  failure: true,
}

/** The kinds this phase actually implements and tests; the other four answer safe defaults. */
export const E2_KINDS = ["completion", "skillRelevance", "contextItem"] as const
export type E2Kind = (typeof E2_KINDS)[number]

export const isE2Kind = (kind: DecisionKind): kind is E2Kind =>
  E2_KINDS.some((candidate) => candidate === kind)

/** The kinds, read from the one record that knows them, so it can never drift from `DecisionSpec`. */
export function decisionKinds(): DecisionKind[] {
  return Object.keys(DECISION_KINDS).filter(isDecisionKind)
}

// ---- the policy: where the thresholds live ---------------------------------------------------

/**
 * How a decision is allowed to be improved by an external provider.
 *
 * The thresholds live here, in the request, and never in the provider: a provider returns raw
 * confidence and probabilities, and the service compares them against this policy. That keeps
 * recalibration out of the network adapter and out of the inputs hash.
 */
export type DecisionPolicy = {
  allowJev: boolean
  minConfidence: number
  minProbability: number
  timeoutMs: number
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  allowJev: true,
  minConfidence: 0.6,
  minProbability: 0.5,
  timeoutMs: 400,
}

// ---- request and result ----------------------------------------------------------------------

export type DecisionRequest<Q extends DecisionKind = DecisionKind> = {
  kind: Q
  state: DecisionSpec[Q]["state"]
  policy: DecisionPolicy
  episodeID?: string
  sessionID?: string
  projectID?: string
}

/** The distributive union: matching on `kind` narrows `state` and `answer` together. */
export type AnyDecisionRequest = { [Q in DecisionKind]: DecisionRequest<Q> }[DecisionKind]

export type DecisionSource = "deterministic" | "jev" | "fallback"

export type DegradedReason =
  | "timeout"
  | "network"
  | "rate-limited"
  | "unauthorized"
  | "malformed"
  | "low-confidence"
  | "budget-exhausted"
  | "breaker-open"
  | "egress-denied"
  | "provider-disabled"

export type DecisionResult<Q extends DecisionKind = DecisionKind> = {
  kind: Q
  answer: DecisionSpec[Q]["answer"]
  source: DecisionSource
  provider: string
  confidence?: number
  probabilities?: Record<string, number>
  modelVersion?: string
  latencyMs: number
  degraded: boolean
  degradedReason?: DegradedReason
  /** The deterministic answer, stored even when the external provider wins: `explain` never re-runs. */
  baseline: DecisionSpec[Q]["answer"]
  baselineRule: string
  inputsHash: string
  decidedAt: number
}

export type AnyDecisionResult = { [Q in DecisionKind]: DecisionResult<Q> }[DecisionKind]

// ---- defensive reading (the `episode.ts` style) ----------------------------------------------

export const isDecisionKind = (value: unknown): value is DecisionKind =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(DECISION_KINDS, value)

export const isDecisionSource = (value: unknown): value is DecisionSource =>
  value === "deterministic" || value === "jev" || value === "fallback"

/** The hash of a question: kind plus its already-redacted state. The policy is not part of it. */
export function decisionInputsHash(kind: DecisionKind, redactedState: string): string {
  return createHash("sha256").update(`${kind}\u0000${redactedState}`).digest("hex")
}
