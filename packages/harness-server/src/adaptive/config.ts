/**
 * The adaptive layer's settings, composed from the Phase 1 resolvers (FH-016).
 *
 * This is a compositor, not a new framework: it calls `resolveRuntimeConfig` and
 * `resolveEpisodeBoundaryConfig` unchanged, resolves the newer slices (decisions, Jev, budget,
 * egress) and hands back one object. `harness-server` has no `config/` self-export of its own, so the
 * composition lives where the settings are read.
 *
 * Precedence is the Phase 1 one — environment, then the global `flupcode.adaptive` block, then the
 * default — and a malformed value is ignored rather than guessed. `createAdaptiveConfig` re-reads the
 * block with a TTL, so the kill switch takes effect without a restart while the hot path does not hit
 * the filesystem on every decision.
 */

import { globalAdaptiveBlock } from "../config-files"
import { DEFAULT_DECISION_POLICY } from "./decision"
import type { ContextItemKind, DecisionKind, DecisionPolicy } from "./decision"
import { resolveEpisodeBoundaryConfig } from "./episode"
import type { EpisodeBoundaryConfig } from "./episode"
import { resolveRuntimeConfig } from "./runtime-config"
import type { RuntimeProbeConfig } from "./runtime-config"
import { DROP_THRESHOLD, KEEP_THRESHOLD } from "./scoring"
import type { ContextBudget } from "./scoring"
import { DEFAULT_GOVERNOR_CONFIG } from "./providers/governor"
import type { GovernorConfig } from "./providers/governor"

export type JevConfig = {
  enabled: boolean
  endpoint: string
  model: string
  timeoutMs: number
  maxInputTokens: number
}

export type BudgetConfig = { monthlyTokens: number; hotReserveFraction: number }

export type EgressConfig = {
  enabled: boolean
  projects: string[]
  kinds: Record<DecisionKind, boolean>
}

export type ContextConfig = {
  /** Whether a plan is computed at all; with the shadow on it is computed even when not applied. */
  enabled: boolean
  /** Whether the plan filters the run prompt. Off by default: promotion needs the evaluation metric. */
  apply: boolean
  keepThreshold: number
  dropThreshold: number
  budget: ContextBudget
}

export type AdaptiveConfig = {
  /** Kill switch: stops decisions, shadow and Jev. It does not touch episodes or the base harness. */
  enabled: boolean
  shadow: boolean
  runtime: RuntimeProbeConfig
  episode: EpisodeBoundaryConfig
  decisions: Record<DecisionKind, DecisionPolicy>
  jev: JevConfig
  budget: BudgetConfig
  egress: EgressConfig
  governor: GovernorConfig
  context: ContextConfig
}

export const DEFAULT_JEV_CONFIG: JevConfig = {
  enabled: false,
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 400,
  maxInputTokens: 32_000,
}

/** A conservative monthly cap; the budget policy is fixed, the number is configuration. */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = { monthlyTokens: 100_000, hotReserveFraction: 0.2 }

/** Conservative per-class token budgets: the policy is fixed by ADR-0018, the numbers are config. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  total: 16_000,
  perClass: {
    objective: 4_000,
    plan: 2_000,
    decision: 2_000,
    handoff: 2_000,
    file: 3_000,
    command: 1_500,
    error: 3_000,
    artifact: 2_000,
    memory: 1_000,
    tool: 500,
    message: 500,
    history: 500,
    skill: 1_000,
    other: 1_000,
  },
}

/** A plan is computed (shadow) but never applied until the evaluation metric promotes it. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  enabled: true,
  apply: false,
  keepThreshold: KEEP_THRESHOLD,
  dropThreshold: DROP_THRESHOLD,
  budget: DEFAULT_CONTEXT_BUDGET,
}

/** How long the composed config is trusted before the global block is read again. */
export const DEFAULT_ADAPTIVE_TTL_MS = 5_000

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveNumberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const unitFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined

const stringListFrom = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []

/** The outer switch: an env kill beats the block, the block beats the default (on). */
const resolveEnabled = (block: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean =>
  env.FLUPCODE_ADAPTIVE_DISABLED === "1" ? false : typeof block.enabled === "boolean" ? block.enabled : true

const policyFrom = (base: DecisionPolicy, value: unknown): DecisionPolicy => {
  if (!isPlainObject(value)) return base
  return {
    allowJev: typeof value.allowJev === "boolean" ? value.allowJev : base.allowJev,
    minConfidence: unitFrom(value.minConfidence) ?? base.minConfidence,
    minProbability: unitFrom(value.minProbability) ?? base.minProbability,
    timeoutMs: positiveNumberFrom(value.timeoutMs) ?? base.timeoutMs,
  }
}

/**
 * The per-kind policies. The `contextItem` policy also carries the resolved scorer thresholds, so the
 * decision baseline and the manager's plan are scored against one source instead of two defaults.
 */
function resolveDecisionPolicies(block: Record<string, unknown>, context: ContextConfig): Record<DecisionKind, DecisionPolicy> {
  const decisions = isPlainObject(block.decisions) ? block.decisions : {}
  return {
    completion: policyFrom(DEFAULT_DECISION_POLICY, decisions.completion),
    skillRelevance: policyFrom(DEFAULT_DECISION_POLICY, decisions.skillRelevance),
    contextItem: {
      ...policyFrom(DEFAULT_DECISION_POLICY, decisions.contextItem),
      keepThreshold: context.keepThreshold,
      dropThreshold: context.dropThreshold,
    },
    modelRoute: policyFrom(DEFAULT_DECISION_POLICY, decisions.modelRoute),
    agentRoute: policyFrom(DEFAULT_DECISION_POLICY, decisions.agentRoute),
    toolRisk: policyFrom(DEFAULT_DECISION_POLICY, decisions.toolRisk),
    failure: policyFrom(DEFAULT_DECISION_POLICY, decisions.failure),
  }
}

function resolveJevConfig(block: Record<string, unknown>): JevConfig {
  const jev = isPlainObject(block.jev) ? block.jev : {}
  return {
    enabled: jev.enabled === true,
    endpoint: stringFrom(jev.endpoint) ?? DEFAULT_JEV_CONFIG.endpoint,
    model: stringFrom(jev.model) ?? DEFAULT_JEV_CONFIG.model,
    timeoutMs: positiveNumberFrom(jev.timeoutMs) ?? DEFAULT_JEV_CONFIG.timeoutMs,
    maxInputTokens: positiveNumberFrom(jev.maxInputTokens) ?? DEFAULT_JEV_CONFIG.maxInputTokens,
  }
}

function resolveBudgetConfig(block: Record<string, unknown>): BudgetConfig {
  const budget = isPlainObject(block.budget) ? block.budget : {}
  return {
    monthlyTokens: positiveNumberFrom(budget.monthlyTokens) ?? DEFAULT_BUDGET_CONFIG.monthlyTokens,
    hotReserveFraction: unitFrom(budget.hotReserveFraction) ?? DEFAULT_BUDGET_CONFIG.hotReserveFraction,
  }
}

/**
 * The context selection slice. `enabled` and `apply` are booleans; a malformed one falls back to the
 * default rather than being guessed. The thresholds accept a unit value and the per-class budgets a
 * positive number, each kind falling back to its own default so a partial block is still complete.
 */
function resolveContextConfig(block: Record<string, unknown>): ContextConfig {
  const context = isPlainObject(block.context) ? block.context : {}
  const budget = isPlainObject(context.budget) ? context.budget : {}
  const perClass = isPlainObject(budget.perClass) ? budget.perClass : {}
  const budgetFor = (kind: ContextItemKind): number =>
    positiveNumberFrom(perClass[kind]) ?? DEFAULT_CONTEXT_BUDGET.perClass[kind]
  return {
    enabled: typeof context.enabled === "boolean" ? context.enabled : DEFAULT_CONTEXT_CONFIG.enabled,
    apply: typeof context.apply === "boolean" ? context.apply : DEFAULT_CONTEXT_CONFIG.apply,
    keepThreshold: unitFrom(context.keepThreshold) ?? DEFAULT_CONTEXT_CONFIG.keepThreshold,
    dropThreshold: unitFrom(context.dropThreshold) ?? DEFAULT_CONTEXT_CONFIG.dropThreshold,
    budget: {
      total: positiveNumberFrom(budget.total) ?? DEFAULT_CONTEXT_BUDGET.total,
      perClass: {
        objective: budgetFor("objective"),
        plan: budgetFor("plan"),
        decision: budgetFor("decision"),
        handoff: budgetFor("handoff"),
        file: budgetFor("file"),
        command: budgetFor("command"),
        error: budgetFor("error"),
        artifact: budgetFor("artifact"),
        memory: budgetFor("memory"),
        tool: budgetFor("tool"),
        message: budgetFor("message"),
        history: budgetFor("history"),
        skill: budgetFor("skill"),
        other: budgetFor("other"),
      },
    },
  }
}

/** Every kind off until the block lists it; a new kind cannot arrive enabled by accident. */
function resolveEgressKinds(value: unknown): Record<DecisionKind, boolean> {
  const kinds = isPlainObject(value) ? value : {}
  return {
    completion: kinds.completion === true,
    skillRelevance: kinds.skillRelevance === true,
    contextItem: kinds.contextItem === true,
    modelRoute: kinds.modelRoute === true,
    agentRoute: kinds.agentRoute === true,
    toolRisk: kinds.toolRisk === true,
    failure: kinds.failure === true,
  }
}

function resolveLimiterConfig(value: unknown): GovernorConfig["limiter"] {
  const limiter = isPlainObject(value) ? value : {}
  const base = DEFAULT_GOVERNOR_CONFIG.limiter
  return {
    initial: positiveNumberFrom(limiter.initial) ?? base.initial,
    max: positiveNumberFrom(limiter.max) ?? base.max,
    min: positiveNumberFrom(limiter.min) ?? base.min,
    restoreEvery: positiveNumberFrom(limiter.restoreEvery) ?? base.restoreEvery,
  }
}

/**
 * The governance settings: breaker, limiter and the budget the governor enforces. The monthly token
 * budget and its hot reserve are the same numbers the budget slice already resolves, so there is one
 * place to change them.
 */
function resolveGovernorConfig(block: Record<string, unknown>): GovernorConfig {
  const governor = isPlainObject(block.governor) ? block.governor : {}
  const budget = resolveBudgetConfig(block)
  return {
    monthlyTokenBudget: budget.monthlyTokens,
    hotReserveFraction: budget.hotReserveFraction,
    breakerFailures: positiveNumberFrom(governor.breakerFailures) ?? DEFAULT_GOVERNOR_CONFIG.breakerFailures,
    breakerCooldownMs: positiveNumberFrom(governor.breakerCooldownMs) ?? DEFAULT_GOVERNOR_CONFIG.breakerCooldownMs,
    limiter: resolveLimiterConfig(governor.limiter),
  }
}

/**
 * The egress posture: the global opt-in is `adaptive.jev.enabled` (off), then the project must be
 * listed and the kind allowlisted. The guard reads `egress.enabled`, so the global switch is mirrored
 * here rather than leaving the guard to reach into the Jev settings.
 */
function resolveEgressConfig(block: Record<string, unknown>): EgressConfig {
  const egress = isPlainObject(block.egress) ? block.egress : {}
  const jev = isPlainObject(block.jev) ? block.jev : {}
  return {
    enabled: jev.enabled === true,
    projects: stringListFrom(egress.projects),
    kinds: resolveEgressKinds(egress.kinds),
  }
}

/** The whole adaptive config from a raw block, composing the Phase 1 resolvers unchanged. */
export function resolveAdaptiveConfig(input: { block?: unknown; env?: NodeJS.ProcessEnv } = {}): AdaptiveConfig {
  const env = input.env ?? process.env
  const block = isPlainObject(input.block) ? input.block : {}
  const context = resolveContextConfig(block)
  return {
    enabled: resolveEnabled(block, env),
    shadow: block.shadow !== false,
    runtime: resolveRuntimeConfig({ block, env }),
    episode: resolveEpisodeBoundaryConfig({ block, env }),
    decisions: resolveDecisionPolicies(block, context),
    jev: resolveJevConfig(block),
    budget: resolveBudgetConfig(block),
    egress: resolveEgressConfig(block),
    governor: resolveGovernorConfig(block),
    context,
  }
}

/**
 * The config reader the running server holds.
 *
 * `current()` answers from a cached composition until the TTL expires, then re-reads the global block
 * — that is what lets the kill switch and the egress opt-in change without a restart. TTL defaults
 * shorter than the runtime probe's so a switch reacts quickly.
 */
export function createAdaptiveConfig(
  input: {
    read?: () => Record<string, unknown>
    env?: NodeJS.ProcessEnv
    ttlMs?: number
    now?: () => number
  } = {},
): { current(): AdaptiveConfig } {
  const read = input.read ?? globalAdaptiveBlock
  const env = input.env ?? process.env
  const ttlMs = input.ttlMs ?? DEFAULT_ADAPTIVE_TTL_MS
  const now = input.now ?? Date.now
  let cached: AdaptiveConfig | undefined
  let checkedAt = 0

  const current = (): AdaptiveConfig => {
    if (cached && now() - checkedAt < ttlMs) return cached
    cached = resolveAdaptiveConfig({ block: read(), env })
    checkedAt = now()
    return cached
  }

  return { current }
}
