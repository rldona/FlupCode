/**
 * Typed decisions the adaptive layer can ask (FH-010).
 *
 * A decision is a question about the session the harness is observing — is this episode complete,
 * which skills matter for this objective, what should happen to this context item — and a typed
 * answer to it. The eight kinds are declared here even though only three carry rich deterministic
 * logic in this phase, so the seam, the audit and the provider dispatch are all exhaustive: adding a
 * kind to `DecisionSpec` does not compile until every map below lists it.
 *
 * This module is the domain and nothing else: no provider, no network, no Jev. It is also the only
 * place that reads a decision's answer out of untrusted data, always falling back to a safe value
 * rather than to a guess (the same defensive style `episode.ts` uses).
 */

import type { Arm } from "./holdout"
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
/**
 * The only kinds `drop` may touch; everything else is archived, which is recoverable. A pack's
 * `artifact` and `file` parts are deliberately **not** here: even with `context.apply=true` they can
 * only be archived (recoverable), never dropped, so a reference a person added to a pack is never
 * lost silently. The scorer and the Jev merge both enforce this, and the manager re-checks it.
 */
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

/**
 * The change a reusable lesson calls for (FH-031). `merge` and `drop` are declared so the vocabulary
 * is closed and the Jev adapter can parse them, but Phase 3b rejects both with a reason: only `add`
 * and `patch` are implemented, and `merge`/`drop` are later phases (ADR-0020 §9).
 */
export const REFLECTION_INTENTS = ["add", "patch", "merge", "drop"] as const
export type ReflectionIntent = (typeof REFLECTION_INTENTS)[number]

export const isReflectionIntent = (value: unknown): value is ReflectionIntent =>
  typeof value === "string" && (REFLECTION_INTENTS as readonly string[]).includes(value)

export type CompletionAnswer = { verdict: "complete" | "not_complete" }
export type SkillRelevanceAnswer = { load: string[] }
export type ContextItemAnswer = { decisions: Array<{ id: string; disposition: ItemDisposition }> }
export type ModelRouteAnswer = { tier: DecisionTier }
export type AgentRouteAnswer = { agent: AgentRoute }
export type ToolRiskAnswer = { risk: ToolRisk }
export type FailureAnswer = { verdict: "continue" | "intervene" }
export type SkillReflectionAnswer = {
  reusable: boolean
  intent: ReflectionIntent
  /** The name of the existing skill a `patch`/`merge` points at, when one was chosen. */
  target?: string
}

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
export type ToolRiskState = { tool: string; argsDigest: string; native?: ToolRisk }
export type FailureState = {
  repeatedCalls: number
  repeatedErrors: number
  stepsUsed: number
  stepsBudget?: number
}
/**
 * What a closed episode offers a reflection decision (FH-031).
 *
 * Bounded signals and a roster, never a transcript: the decision is *whether* a lesson is reusable
 * and *what* it calls for, and the small model drafts the text afterwards. `skills` is the current
 * roster so a `patch`/`merge` can point at a real skill by name.
 */
export type SkillReflectionState = {
  episodeID: string
  objective: string
  outcome: EpisodeOutcome
  toolCalls: number
  /** Bounded, deterministic signals ("verify:test ok", "file:src/x.ts", "failure:…"). */
  signals: string[]
  skills: Array<{ name: string; description: string; learned: boolean }>
}

/** The map that defines the eight kinds and correlates each state with its answer. */
export type DecisionSpec = {
  completion: { state: CompletionState; answer: CompletionAnswer }
  skillRelevance: { state: SkillRelevanceState; answer: SkillRelevanceAnswer }
  contextItem: { state: ContextItemState; answer: ContextItemAnswer }
  modelRoute: { state: ModelRouteState; answer: ModelRouteAnswer }
  agentRoute: { state: AgentRouteState; answer: AgentRouteAnswer }
  toolRisk: { state: ToolRiskState; answer: ToolRiskAnswer }
  failure: { state: FailureState; answer: FailureAnswer }
  skillReflection: { state: SkillReflectionState; answer: SkillReflectionAnswer }
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
  skillReflection: true,
}

/** The kinds this phase actually implements and tests; the other kinds answer safe defaults. */
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
  /**
   * The failure/loop thresholds, carried only by `failure` policies (FH-060/061, ADR-0023 §6). The
   * detector is pure, so the numbers live on the request and a deterministic baseline and its audit
   * row agree on them; absent means the handler's own default.
   */
  repeatedCalls?: number
  repeatedErrors?: number
}

/**
 * Whether the policy lets a predictive model improve the decision, whichever model is assigned.
 *
 * The field keeps its historical name `allowJev` because it is persisted verbatim (the audit's
 * `policy_json`, the `decisions.<kind>` config block); renaming it is a migration, not a refactor.
 */
export const allowsModel = (policy: DecisionPolicy): boolean => policy.allowJev

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
  /** The session's holdout arm for the capability asking (AH-B05); recorded, never acted on here. */
  arm?: Arm
}

/** The distributive union: matching on `kind` narrows `state` and `answer` together. */
export type AnyDecisionRequest = { [Q in DecisionKind]: DecisionRequest<Q> }[DecisionKind]

/**
 * Who answered a decision, whichever model was involved (AH-C02).
 *
 * `baseline` means no model was consulted and the deterministic rule answered; `model` means a
 * predictive model answered and cleared the policy; `fallback` means a model was consulted but the
 * rule answered anyway (it failed or fell below the thresholds). Which model it was lives in the
 * audit's `provider_id`, never in the source.
 */
export const DECISION_SOURCES = ["baseline", "model", "fallback"] as const
export type DecisionSource = (typeof DECISION_SOURCES)[number]

/**
 * Who scored a context plan. A plan is either the scorer's alone or refined by a model on top of it;
 * a model that was consulted and did not win leaves the plan the scorer's (`baseline`).
 */
export type PlanScoreSource = Extract<DecisionSource, "baseline" | "model">

/**
 * The outcome a decision is later labelled with (AH-C06 fills it; AH-C02 only reserves the column).
 *
 * `unknown` is a real label — the outcome was looked at and could not be judged — which is different
 * from a decision that carries no label at all.
 */
export const DECISION_LABEL_OUTCOMES = ["correct", "incorrect", "unknown"] as const
export type DecisionLabelOutcome = (typeof DECISION_LABEL_OUTCOMES)[number]

/**
 * A per-kind outcome label as it is written (AH-C06): how the answer scored, how the baseline answer
 * would have scored against the same observed outcome (the counterfactual an uplift needs), and what
 * produced it (an episode outcome, the skill loads of a turn, a replay).
 */
export type DecisionLabelInput = {
  outcome: DecisionLabelOutcome
  baselineOutcome?: DecisionLabelOutcome
  source: string
}

/** A label as it is read back, with when it was written. */
export type DecisionLabel = DecisionLabelInput & { labeledAt: number }

/** How a kind's decisions in a window read: how many there were and how their labels came out. */
export type DecisionLabelCounts = {
  eligible: number
  labeled: number
  correct: number
  incorrect: number
  unknown: number
}

/**
 * Why a decision did not take a model's answer.
 *
 * Most reasons are faults of a consulted model (`source: "fallback"`). The last three are deliberate
 * skips by the value-of-information gate (AH-C05): the model was not asked at all, so the row keeps
 * `source: "baseline"` and no provider, and is marked degraded so the pause stays visible.
 */
export const DEGRADED_REASONS = [
  "timeout",
  "network",
  "rate-limited",
  "unauthorized",
  "malformed",
  "low-confidence",
  "budget-exhausted",
  "breaker-open",
  "egress-denied",
  "provider-disabled",
  /** The model's measured uplift over the baseline is at most ε: the kind is paused for it. */
  "voi-paused",
  /** The model helps, but its expected value does not cover its cost and latency. */
  "voi-below-cost",
  /** A hot decision whose model's measured p95 latency exceeds the request deadline. */
  "p95-over-deadline",
] as const
export type DegradedReason = (typeof DEGRADED_REASONS)[number]

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
  typeof value === "string" && (DECISION_SOURCES as readonly string[]).includes(value)

export const isDecisionLabelOutcome = (value: unknown): value is DecisionLabelOutcome =>
  typeof value === "string" && (DECISION_LABEL_OUTCOMES as readonly string[]).includes(value)

/** The hash of a question: kind plus its already-redacted state. The policy is not part of it. */
export function decisionInputsHash(kind: DecisionKind, redactedState: string): string {
  return createHash("sha256").update(`${kind}\u0000${redactedState}`).digest("hex")
}
