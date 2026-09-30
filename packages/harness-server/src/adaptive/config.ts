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
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
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

/**
 * Which registered predictive model each kind asks (AH-C01), by model id. A kind that is absent asks
 * no model and keeps the deterministic baseline.
 */
export type ModelAssignments = Partial<Record<DecisionKind, string>>

/** The id that pins a kind to the deterministic baseline, overriding the legacy Jev assignment. */
export const BASELINE_MODEL = "baseline"

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

/**
 * The acting slice (FH-04, ADR-0021 §6): off by default, like learning, because acting without a
 * measured evaluation is not allowed. `rosterTtlMs` bounds both the roster cache and the per-turn
 * decision cache; `timeoutMs` is the hot deadline the relevance path passes as the request policy.
 */
export type RelevanceConfig = {
  enabled: boolean
  maxSkills: number
  rosterTtlMs: number
  timeoutMs: number
}

/**
 * The retention slice (ADR-0022 §2): **off by default**, so nothing expires until a person opts in,
 * consistent with archive-not-delete. When on, one transactional purge limits the four adaptive
 * audit tables, with a window per state. A window is conservative configuration, not policy.
 */
export type RetentionConfig = {
  /** Off by default: nothing expires until a human opts in at activation. */
  enabled: boolean
  /** Shadow decisions (one per episode/kind). */
  decisionsDays: number
  /** Acting decisions (`shadow = 0`, one per turn). Kept longer: they explain what was suggested live. */
  actingDays: number
  /** Plans that never filtered a prompt. */
  plansDays: number
  /** Plans that actually filtered (`applied = 1`). */
  appliedPlansDays: number
  /** Terminal reflection jobs (`done | skipped | failed`). */
  reflectionDays: number
  /** Rejected proposals only. */
  rejectedProposalsDays: number
}

/**
 * The failure/loop guardrails slice (FH-060–063, ADR-0023): **off by default**, like every acting
 * feature. `repeatedCalls`/`repeatedErrors` are the detector thresholds, `windowMs` and
 * `maxObservations` bound the per-session ring, `maxSessions` bounds the number of rings, and
 * `timeoutMs` is the hot deadline the service passes as the request policy. The threshold value `3`
 * is aligned to the engine's own `DOOM_LOOP_THRESHOLD`, but it is an independent configured number.
 */
export type GuardrailsConfig = {
  enabled: boolean
  repeatedCalls: number
  repeatedErrors: number
  windowMs: number
  maxObservations: number
  maxSessions: number
  timeoutMs: number
}

/**
 * The per-session holdout (AH-B05): the share of sessions each acting capability leaves alone, so an
 * online comparison has a control arm. `0` turns the holdout off; it is capped at one half.
 */
export type HoldoutConfig = { fraction: number }

export type LearningConfig = {
  /** Off by default: it gates reflection, the `skillReflection` classification, the draft and writes. */
  enabled: boolean
  /** The tool-call cadence an episode must reach before it may be reflected at all (FH-030). */
  minToolCalls: number
  /** How many pre-patch snapshots a learned skill keeps under `.versions/`. */
  snapshotKeep: number
  /** The cap on the transcript handed to the drafting model (ADR-0020 §5). */
  maxInputChars: number
  /** The cap on the drafted body before it is stored (ADR-0020 §2). */
  maxBodyChars: number
  /**
   * How long the drafting session may generate before it is stopped and deleted. Its own number, not
   * the `skillReflection` decision deadline: that one is a hot-path latency budget, a draft is not.
   */
  draftTimeoutMs: number
  /** Opportunities a `probation` learned skill must have had before the lifecycle judges it (FH-042). */
  probationSample: number
  /** Opportunities without a load or view after which a `mature` skill turns `stale`. */
  staleAfter: number
  /** Opportunities without a load or view after which a `stale` skill is archived. */
  archiveAfter: number
  /** A `provider/model` key for the drafting model; falls back to the global `small_model`. */
  model?: string
}

export type AdaptiveConfig = {
  /** Kill switch: stops decisions, shadow and Jev. It does not touch episodes or the base harness. */
  enabled: boolean
  shadow: boolean
  runtime: RuntimeProbeConfig
  episode: EpisodeBoundaryConfig
  decisions: Record<DecisionKind, DecisionPolicy>
  /** The predictive model per kind; see `resolveModelAssignments` for the legacy fallback. */
  models: ModelAssignments
  jev: JevConfig
  budget: BudgetConfig
  egress: EgressConfig
  governor: GovernorConfig
  context: ContextConfig
  learning: LearningConfig
  relevance: RelevanceConfig
  retention: RetentionConfig
  guardrails: GuardrailsConfig
  holdout: HoldoutConfig
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

/**
 * Learning is off until a project opts in (ADR-0020 §5). The numbers are conservative and configurable:
 * the tool-call cadence of the deterministic evidence gate, and how many pre-patch snapshots a learned
 * skill keeps. The default snapshot count must stay in step with `SNAPSHOT_KEEP` in `skills/learned-store.ts`.
 */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  minToolCalls: 5,
  snapshotKeep: 5,
  // Mirrors `DEFAULT_MAX_INPUT_CHARS` and `DRAFT_LIMITS.maxBodyChars` in `learning/draft.ts`; a test
  // keeps the three numbers in step rather than importing across the slice.
  maxInputChars: 8_000,
  maxBodyChars: 4_000,
  // The same two minutes `Engine.commitMessage`/`handoff` give their throwaway sessions.
  draftTimeoutMs: 120_000,
  probationSample: 5,
  staleAfter: 10,
  archiveAfter: 20,
}

/**
 * The relevance slice defaults: opt-in (ADR-0021 §6), top-3, a 5 s cache and a 400 ms hot deadline
 * (the same budget the decision policy uses, so the Jev deadline fires before the plugin's).
 */
export const DEFAULT_RELEVANCE_CONFIG: RelevanceConfig = {
  enabled: false,
  maxSkills: 3,
  rosterTtlMs: 5_000,
  timeoutMs: 400,
}

/** Conservative defaults for the opt-in retention policy; the numbers are configuration, not policy. */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  enabled: false,
  decisionsDays: 30,
  actingDays: 90,
  plansDays: 30,
  appliedPlansDays: 90,
  reflectionDays: 30,
  rejectedProposalsDays: 30,
}

/** The validation strategy's 20% holdout (audit §14.2). */
export const DEFAULT_HOLDOUT_CONFIG: HoldoutConfig = { fraction: 0.2 }

/**
 * The guardrails defaults: opt-in (ADR-0023 §6), a 10-minute window with the newest 200 observations
 * per session and at most 500 sessions, and a 300 ms hot deadline. `repeatedCalls`/`repeatedErrors`
 * mirror the engine's `DOOM_LOOP_THRESHOLD` by value; they are not a shared constant.
 */
export const DEFAULT_GUARDRAILS_CONFIG: GuardrailsConfig = {
  enabled: false,
  repeatedCalls: 3,
  repeatedErrors: 3,
  windowMs: 600_000,
  maxObservations: 200,
  maxSessions: 500,
  timeoutMs: 300,
}

/**
 * The most the server-side relevance deadline may reach. The installed plugin bounds its own fetch at
 * 500 ms by default (`FETCH_TIMEOUT_MS` in `packages/remote/src/engine-plugins.ts`), so the server's
 * deadline has to stay strictly below it for the server to answer first; a larger configured value is
 * clamped here rather than letting the plugin abort and the line vanish without a trace. Raising the
 * plugin's timeout means raising this constant in step.
 */
export const RELEVANCE_TIMEOUT_MS_CEILING = 450

/**
 * The most names the line may carry. The installed plugin refuses anything but the fixed box with at
 * most three `NAME` tokens (`MAX_LINE_SKILLS` in `packages/remote/src/engine-plugins.ts`), so a larger
 * `maxSkills` would render a line the plugin drops and the feature would go silent. The cap keeps the
 * writer and the reader in step; a smaller value is still honored.
 */
export const RELEVANCE_MAX_SKILLS_CEILING = 3

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
function resolveDecisionPolicies(
  block: Record<string, unknown>,
  context: ContextConfig,
  guardrails: GuardrailsConfig,
): Record<DecisionKind, DecisionPolicy> {
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
    // The failure thresholds are the guardrails slice, so the detector and its decision policy agree.
    failure: {
      ...policyFrom(DEFAULT_DECISION_POLICY, decisions.failure),
      repeatedCalls: guardrails.repeatedCalls,
      repeatedErrors: guardrails.repeatedErrors,
    },
    skillReflection: policyFrom(DEFAULT_DECISION_POLICY, decisions.skillReflection),
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

/**
 * The model per kind: `adaptive.models.<kind> = "<model id>"`.
 *
 * A kind the block does not name falls back to the behaviour before the registry existed: Jev when
 * `jev.enabled`, else no model. That fallback is per kind, so a config without a `models` block reads
 * exactly as it always did, and one that names a single kind leaves the others where they were.
 * `"baseline"` pins a kind to the deterministic answer even with Jev on. An id no model is registered
 * under also keeps the baseline: the service only asks a registered model that supports the kind.
 */
function resolveModelAssignments(block: Record<string, unknown>): ModelAssignments {
  const models = isPlainObject(block.models) ? block.models : {}
  const legacy = isPlainObject(block.jev) && block.jev.enabled === true ? "jev" : undefined
  return Object.fromEntries(
    decisionKinds().flatMap((kind) => {
      const id = stringFrom(models[kind]) ?? legacy
      return id === undefined || id === BASELINE_MODEL ? [] : [[kind, id] as const]
    }),
  )
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

/**
 * The learning slice: off unless the block says `true`, and the gate's numbers fall back to their
 * conservative defaults. A malformed value is ignored rather than guessed, so a bad `minToolCalls`
 * cannot make the gate spend.
 */
function resolveLearningConfig(block: Record<string, unknown>): LearningConfig {
  const learning = isPlainObject(block.learning) ? block.learning : {}
  const model = stringFrom(learning.model)
  return {
    enabled: learning.enabled === true,
    minToolCalls: positiveNumberFrom(learning.minToolCalls) ?? DEFAULT_LEARNING_CONFIG.minToolCalls,
    snapshotKeep: positiveNumberFrom(learning.snapshotKeep) ?? DEFAULT_LEARNING_CONFIG.snapshotKeep,
    maxInputChars: positiveNumberFrom(learning.maxInputChars) ?? DEFAULT_LEARNING_CONFIG.maxInputChars,
    maxBodyChars: positiveNumberFrom(learning.maxBodyChars) ?? DEFAULT_LEARNING_CONFIG.maxBodyChars,
    draftTimeoutMs: positiveNumberFrom(learning.draftTimeoutMs) ?? DEFAULT_LEARNING_CONFIG.draftTimeoutMs,
    probationSample: positiveNumberFrom(learning.probationSample) ?? DEFAULT_LEARNING_CONFIG.probationSample,
    staleAfter: positiveNumberFrom(learning.staleAfter) ?? DEFAULT_LEARNING_CONFIG.staleAfter,
    archiveAfter: positiveNumberFrom(learning.archiveAfter) ?? DEFAULT_LEARNING_CONFIG.archiveAfter,
    ...(model ? { model } : {}),
  }
}

/**
 * The relevance slice: off unless the block says `true`, with every number falling back to its own
 * default. A malformed value is ignored rather than guessed, so a bad `maxSkills` cannot open the
 * line to more names than the writer allows.
 */
function resolveRelevanceConfig(block: Record<string, unknown>): RelevanceConfig {
  const relevance = isPlainObject(block.relevance) ? block.relevance : {}
  return {
    enabled: relevance.enabled === true,
    maxSkills: Math.min(
      positiveNumberFrom(relevance.maxSkills) ?? DEFAULT_RELEVANCE_CONFIG.maxSkills,
      RELEVANCE_MAX_SKILLS_CEILING,
    ),
    rosterTtlMs: positiveNumberFrom(relevance.rosterTtlMs) ?? DEFAULT_RELEVANCE_CONFIG.rosterTtlMs,
    timeoutMs: Math.min(
      positiveNumberFrom(relevance.timeoutMs) ?? DEFAULT_RELEVANCE_CONFIG.timeoutMs,
      RELEVANCE_TIMEOUT_MS_CEILING,
    ),
  }
}

/**
 * The retention slice: off unless the block says `true`, with every window falling back to its
 * conservative default. A malformed or non-positive value is ignored rather than guessed, so a bad
 * window cannot make the purge delete more than intended.
 */
function resolveRetentionConfig(block: Record<string, unknown>): RetentionConfig {
  const retention = isPlainObject(block.retention) ? block.retention : {}
  return {
    enabled: retention.enabled === true,
    decisionsDays: positiveNumberFrom(retention.decisionsDays) ?? DEFAULT_RETENTION_CONFIG.decisionsDays,
    actingDays: positiveNumberFrom(retention.actingDays) ?? DEFAULT_RETENTION_CONFIG.actingDays,
    plansDays: positiveNumberFrom(retention.plansDays) ?? DEFAULT_RETENTION_CONFIG.plansDays,
    appliedPlansDays: positiveNumberFrom(retention.appliedPlansDays) ?? DEFAULT_RETENTION_CONFIG.appliedPlansDays,
    reflectionDays: positiveNumberFrom(retention.reflectionDays) ?? DEFAULT_RETENTION_CONFIG.reflectionDays,
    rejectedProposalsDays:
      positiveNumberFrom(retention.rejectedProposalsDays) ?? DEFAULT_RETENTION_CONFIG.rejectedProposalsDays,
  }
}

/**
 * The guardrails slice: off unless the block says `true`, every number falling back to its own
 * default. A malformed value is ignored rather than guessed, so a bad threshold cannot arm the
 * detector with a nonsensical bound.
 */
function resolveGuardrailsConfig(block: Record<string, unknown>): GuardrailsConfig {
  const guardrails = isPlainObject(block.guardrails) ? block.guardrails : {}
  return {
    enabled: guardrails.enabled === true,
    repeatedCalls: positiveNumberFrom(guardrails.repeatedCalls) ?? DEFAULT_GUARDRAILS_CONFIG.repeatedCalls,
    repeatedErrors: positiveNumberFrom(guardrails.repeatedErrors) ?? DEFAULT_GUARDRAILS_CONFIG.repeatedErrors,
    windowMs: positiveNumberFrom(guardrails.windowMs) ?? DEFAULT_GUARDRAILS_CONFIG.windowMs,
    maxObservations: positiveNumberFrom(guardrails.maxObservations) ?? DEFAULT_GUARDRAILS_CONFIG.maxObservations,
    maxSessions: positiveNumberFrom(guardrails.maxSessions) ?? DEFAULT_GUARDRAILS_CONFIG.maxSessions,
    timeoutMs: positiveNumberFrom(guardrails.timeoutMs) ?? DEFAULT_GUARDRAILS_CONFIG.timeoutMs,
  }
}

/** The holdout share: a number in [0, 0.5], else the default. `0` is an explicit off. */
function resolveHoldoutConfig(block: Record<string, unknown>): HoldoutConfig {
  const holdout = isPlainObject(block.holdout) ? block.holdout : {}
  const fraction = holdout.fraction
  return {
    fraction:
      typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 0.5
        ? fraction
        : DEFAULT_HOLDOUT_CONFIG.fraction,
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
    skillReflection: kinds.skillReflection === true,
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
  const guardrails = resolveGuardrailsConfig(block)
  return {
    enabled: resolveEnabled(block, env),
    shadow: block.shadow !== false,
    runtime: resolveRuntimeConfig({ block, env }),
    episode: resolveEpisodeBoundaryConfig({ block, env }),
    decisions: resolveDecisionPolicies(block, context, guardrails),
    models: resolveModelAssignments(block),
    jev: resolveJevConfig(block),
    budget: resolveBudgetConfig(block),
    egress: resolveEgressConfig(block),
    governor: resolveGovernorConfig(block),
    context,
    learning: resolveLearningConfig(block),
    relevance: resolveRelevanceConfig(block),
    retention: resolveRetentionConfig(block),
    guardrails,
    holdout: resolveHoldoutConfig(block),
  }
}

/**
 * The config reader the running server holds.
 *
 * `current()` answers from a cached composition until the TTL expires, then re-reads the global block
 * — that is what lets the kill switch and the egress opt-in change without a restart. TTL defaults
 * shorter than the runtime probe's so a switch reacts quickly. `raw()` returns the block `current()`
 * composed from, for a reader that needs the keys the resolver does not carry; it shares the cache.
 * `invalidate()` drops that cache so the next read sees a write immediately instead of after the TTL.
 */
export function createAdaptiveConfig(
  input: {
    read?: () => Record<string, unknown>
    env?: NodeJS.ProcessEnv
    ttlMs?: number
    now?: () => number
  } = {},
): { current(): AdaptiveConfig; raw(): Record<string, unknown>; invalidate(): void } {
  const read = input.read ?? globalAdaptiveBlock
  const env = input.env ?? process.env
  const ttlMs = input.ttlMs ?? DEFAULT_ADAPTIVE_TTL_MS
  const now = input.now ?? Date.now
  let cached: AdaptiveConfig | undefined
  let block: Record<string, unknown> | undefined
  let checkedAt = 0

  const load = (): void => {
    block = read()
    cached = resolveAdaptiveConfig({ block, env })
    checkedAt = now()
  }

  const stale = (): boolean => cached === undefined || block === undefined || now() - checkedAt >= ttlMs

  const current = (): AdaptiveConfig => {
    if (stale()) load()
    return cached!
  }

  const raw = (): Record<string, unknown> => {
    if (stale()) load()
    return block!
  }

  const invalidate = (): void => {
    cached = undefined
    block = undefined
    checkedAt = 0
  }

  return { current, raw, invalidate }
}
