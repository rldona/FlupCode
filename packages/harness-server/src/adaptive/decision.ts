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

// ---- the context item model (FH-020) ---------------------------------------------------------

/**
 * The closed vocabulary of things a context item can be.
 *
 * `other` catches anything outside it and is protected; `skill` is reserved for Phase 3b/4 and the
 * Phase 3a classifiers never emit it, but declaring it keeps the type ready without dead code.
 */
export const CONTEXT_ITEM_KINDS = [
  "objective", // the objective of the task/run — never dropped
  "plan", // the current plan
  "decision", // a decision and its rationale
  "handoff", // what a previous task concluded
  "file", // a file/code reference
  "command", // a command that ran
  "error", // an error / red check — never dropped
  "artifact", // an artifact quoted in the prompt
  "memory", // a project note (human data, not an instruction)
  "tool", // a tool call (scope + outcome)
  "message", // agent narration
  "history", // historical conversation
  "skill", // RESERVED to 3b/Phase 4; 3a never emits it
  "other", // unknown — never dropped
] as const
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number]

/**
 * The kinds a plan never archives nor drops ("no-drop" in plan §7.2).
 *
 * `memory` is a human project note — an instruction a person wrote for every turn — so it is as
 * protected as the objective: archiving it would silently drop a directive from the prompt. The
 * `@artifact:` refs and `contextFiles` stay archivable.
 */
export const PROTECTED_CONTEXT_KINDS: readonly ContextItemKind[] = ["objective", "error", "other", "memory"]
/** The only kinds `drop` may touch; everything else is archived, which is recoverable. */
export const DROPPABLE_CONTEXT_KINDS: readonly ContextItemKind[] = ["tool", "message", "history"]

export const isContextItemKind = (value: unknown): value is ContextItemKind =>
  typeof value === "string" && (CONTEXT_ITEM_KINDS as readonly string[]).includes(value)

/**
 * The item observed: a descriptor, never content. The text lives in its durable source (a pack, an
 * artifact, a handoff or `evidence`). `importance`/`novelty`/`state`/`reason` are results, not
 * observations, and live on the plan entry instead.
 */
export type ContextItem = {
  id: string
  kind: ContextItemKind
  tokens: number
  /** Names something in the current objective (lexical). */
  referenced: boolean
  /** How many paths/commands/errors it carries; the scorer caps it. */
  anchors: number
  /** Archived by an earlier plan; a referenced archived item can recover. */
  archived: boolean
  createdAt?: number
}

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
export type ContextItemState = { objective: string; items: ContextItem[] }
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
  /**
   * The context scorer thresholds, carried only by `contextItem` policies, so the deterministic
   * baseline scores on the same resolved numbers as the manager's plan instead of the defaults.
   */
  keepThreshold?: number
  dropThreshold?: number
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
  /**
   * An explicit scope for the deterministic id when no episode or session names it (FH-023).
   *
   * A run prompt is planned per `(runID, taskID)` and never belongs to an episode, so it passes
   * `"${runID}:${taskID}"` here; with the field absent the service keeps Phase 2's fallback chain.
   */
  scopeID?: string
  /**
   * The clock the request was built at, forwarded to the deterministic baseline so a scorer plan
   * and its audit row agree when the items carry `createdAt` (FH-023). Absent means the provider's
   * own clock, exactly as before.
   */
  now?: number
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
