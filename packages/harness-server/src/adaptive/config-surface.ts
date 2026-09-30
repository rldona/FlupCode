/**
 * The policy of the adaptive settings surface (FH-070, ADR-0017/0018/0020/0021/0022).
 *
 * This is the only module that decides **what may be written**. It holds the allowlist of switches,
 * the type checks, the guards and the confirmation rules; the HTTP shape lives in `config-routes.ts`
 * and the bytes on disk are written by `config-write.ts`. Guards are evaluated on the **effective
 * config after the patch**, resolved through `resolveAdaptiveConfig`, so a guard can be satisfied by
 * prior configuration or by the same patch and the order of leaves never matters.
 *
 * The writer only ever touches the leaf `flupcode.adaptive` of the chosen config file: a leaf outside
 * the allowlist is refused with `unsupported-field` before any byte is written.
 */

import { join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { configDirectory } from "../context"
import { applyEditsToFile, ConfigWriteError, isFile, tryReadConfigText } from "../config-write"
import type { AdaptiveUsageRepository } from "../types"
import { LEGACY_EGRESS_PROVIDER, PROVIDER_ID_PATTERN, legacyEgressProvider, resolveAdaptiveConfig } from "./config"
import type { AdaptiveConfig } from "./config"
import type { EgressSubject } from "./egress"
import { decisionKinds, isDecisionKind } from "./decision"
import { budgetMonth } from "./providers/budget"
import { learningModel } from "./learning/draft"
import type { RuntimeAlert, RuntimeCapabilities, RuntimeKind } from "./runtime"
import type { ProjectLimitHit } from "./learning/limits"
import type { ModelKeySource, ModelKeyStatus } from "./model-key"

/** A rejected patch, or a write that could not be made, in the shape the HTTP contract reports. */
export class AdaptiveConfigError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields?: string[],
    readonly missing?: string[],
  ) {
    super(message)
    this.name = "AdaptiveConfigError"
  }
}

export type AdaptiveFieldType = "boolean" | "string-list" | "kinds" | "number" | "count"
export type AdaptiveConfirmation = "none" | "required" | "widening"
export type AdaptiveGuard = "none" | "env-disabled" | "adaptive-token" | "egress-allowlist"
export type AdaptiveWarning =
  | "evaluation-gated"
  | "runtime-inert"
  | "no-model"
  | "skills-still-load"
  | "learning-draft-egress"
  | "classifier-no-consent"

/**
 * One switch the settings panel may render; the list is the whole allowlist. A `*` segment stands for
 * a provider id (`egress.providers.*.enabled`), which must match `PROVIDER_ID_PATTERN`.
 */
export type WritableField = {
  path: string
  type: AdaptiveFieldType
  confirmation: AdaptiveConfirmation
  guard: AdaptiveGuard
  warning?: AdaptiveWarning
}

const FORMAT = { insertSpaces: true, tabSize: 2 } as const

const CANDIDATE_NAMES = ["opencode.jsonc", "opencode.json", "config.json"] as const

/**
 * The switches E8 exposes. Everything else in `flupcode.adaptive` is read-only here: this is "make
 * the opt-ins visible", not "edit every number".
 */
export const WRITABLE_FIELDS: readonly WritableField[] = [
  { path: "enabled", type: "boolean", confirmation: "none", guard: "env-disabled" },
  { path: "shadow", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.enabled", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.apply", type: "boolean", confirmation: "none", guard: "none", warning: "evaluation-gated" },
  // Learning drafts a skill by sending the redacted objective and evidence to the small model's
  // provider through the engine, so turning it on is an egress decision and asks for confirmation.
  // It needs no classifier consent: without one the manager falls back to the local heuristic
  // classifier (AH-F01), which sends nothing, and the egress guard still stops the classifier call.
  {
    path: "learning.enabled",
    type: "boolean",
    confirmation: "required",
    guard: "none",
    warning: "learning-draft-egress",
  },
  // The freeze and the caps (AH-F03) only ever narrow what learning already consented to: freezing
  // stops new jobs, and a cap is clamped to its ceiling by the resolver, so neither sends anything new
  // off the machine and none asks for confirmation. A cap must be a positive count; `frozen` stops.
  { path: "learning.frozen", type: "boolean", confirmation: "none", guard: "none" },
  { path: "learning.limits.proposalsPerDay", type: "count", confirmation: "none", guard: "none" },
  { path: "learning.limits.maxLearnedSkills", type: "count", confirmation: "none", guard: "none" },
  { path: "learning.limits.patchesPerWeek", type: "count", confirmation: "none", guard: "none" },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "guardrails.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  // The trim's plugin calls the loopback with the adaptive bearer, so without one it could never act.
  { path: "toolTrim.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  // `jev.enabled` assigns Jev to every kind without a `models` entry; it may only be turned on once
  // Jev's own consent (`egress.providers.jev`) is on with a project and a kind.
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  // Consent per remote provider (AH-C03): turning one on, or widening what it may receive, is an
  // egress decision about that provider only, and asks for confirmation.
  { path: "egress.providers.*.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.providers.*.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.providers.*.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
  { path: "budget.monthlyTokens", type: "number", confirmation: "none", guard: "none" },
  // The compaction anchors (AH-D04) only enrich the engine's own prompt and are capped and
  // fail-open, so they toggle freely; the replay runner flips them to measure their effect.
  { path: "compaction.anchors", type: "boolean", confirmation: "none", guard: "none" },
  // Per-step selection (AH-D03) is writable only so a replay variant can switch it and set its cold
  // gap; the settings panel draws no control for either, and it stays off until the replay promotes it.
  // Its plugin reads the policy with the adaptive bearer, so without one it could never act.
  { path: "selection.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token", warning: "evaluation-gated" },
  { path: "selection.coldGapMs", type: "number", confirmation: "none", guard: "none" },
]

const WRITABLE_BY_PATH = new Map(WRITABLE_FIELDS.map((field) => [field.path, field]))

/** The descriptor a concrete leaf path writes through, a provider id matching the `*` segment. */
function writableFor(segments: readonly string[]): WritableField | undefined {
  // A dotted key would be written as one key the resolver never reads; a literal `*` is not an id.
  if (segments.some((segment) => segment.includes(".") || segment === "*")) return undefined
  const exact = WRITABLE_BY_PATH.get(segments.join("."))
  if (exact) return exact
  const [root, group, id, leaf, ...rest] = segments
  if (root !== "egress" || group !== "providers" || id === undefined || leaf === undefined || rest.length > 0)
    return undefined
  return PROVIDER_ID_PATTERN.test(id) ? WRITABLE_BY_PATH.get(`egress.providers.*.${leaf}`) : undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveNumberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const RUNTIME_OVERRIDES = ["auto", "legacy", "v2", "off"] as const

const runtimeOverrideFrom = (value: unknown): (typeof RUNTIME_OVERRIDES)[number] | undefined =>
  typeof value === "string" ? RUNTIME_OVERRIDES.find((override) => override === value) : undefined

const usageOf = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {})

// ---- provenance (A3) ---------------------------------------------------------------------------

export type AdaptiveProvenance = "env" | "block" | "default"

/**
 * Where each settings leaf takes its value from, for the settings panel to show.
 *
 * This is a projection over the raw block and the environment, not a second resolver: it mirrors the
 * precedence `resolveAdaptiveConfig` applies (`env > block > default`) and is pinned against it by a
 * test. A key is `block` only when the block carries a well-typed value for it.
 */
export function adaptiveSource(block: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, AdaptiveProvenance> {
  const probe = usageOf(block.probe)
  const episode = usageOf(block.episode)
  const context = usageOf(block.context)
  const learning = usageOf(block.learning)
  const limits = usageOf(learning.limits)
  const relevance = usageOf(block.relevance)
  const guardrails = usageOf(block.guardrails)
  const toolTrim = usageOf(block.toolTrim)
  const jev = usageOf(block.jev)
  const retention = usageOf(block.retention)
  const egress = usageOf(block.egress)
  const providers = usageOf(egress.providers)
  const budget = usageOf(block.budget)
  const compaction = usageOf(block.compaction)
  const selection = usageOf(block.selection)
  const pick = (fromEnv: boolean, fromBlock: boolean): AdaptiveProvenance => (fromEnv ? "env" : fromBlock ? "block" : "default")
  const envNumber = (name: string) => positiveNumberFrom(Number(env[name]))
  return {
    enabled: pick(env.FLUPCODE_ADAPTIVE_DISABLED === "1", typeof block.enabled === "boolean"),
    shadow: pick(false, typeof block.shadow === "boolean"),
    "context.enabled": pick(false, typeof context.enabled === "boolean"),
    "context.apply": pick(false, typeof context.apply === "boolean"),
    "learning.enabled": pick(false, typeof learning.enabled === "boolean"),
    "learning.frozen": pick(false, typeof learning.frozen === "boolean"),
    // A cap below 1 falls back to its default in the resolver, so only a count of at least 1 is `block`.
    "learning.limits.proposalsPerDay": pick(false, (positiveNumberFrom(limits.proposalsPerDay) ?? 0) >= 1),
    "learning.limits.maxLearnedSkills": pick(false, (positiveNumberFrom(limits.maxLearnedSkills) ?? 0) >= 1),
    "learning.limits.patchesPerWeek": pick(false, (positiveNumberFrom(limits.patchesPerWeek) ?? 0) >= 1),
    "relevance.enabled": pick(false, typeof relevance.enabled === "boolean"),
    "guardrails.enabled": pick(false, typeof guardrails.enabled === "boolean"),
    "toolTrim.enabled": pick(false, typeof toolTrim.enabled === "boolean"),
    "jev.enabled": pick(false, typeof jev.enabled === "boolean"),
    "retention.enabled": pick(false, typeof retention.enabled === "boolean"),
    ...providerSources(providers, jev, egress),
    "budget.monthlyTokens": pick(false, positiveNumberFrom(budget.monthlyTokens) !== undefined),
    "compaction.anchors": pick(false, typeof compaction.anchors === "boolean"),
    "selection.enabled": pick(false, typeof selection.enabled === "boolean"),
    "selection.coldGapMs": pick(false, Number.isInteger(selection.coldGapMs) && positiveNumberFrom(selection.coldGapMs) !== undefined),
    "runtime.enabled": pick(env.FLUPCODE_ADAPTIVE_PROBE_DISABLED === "1", typeof probe.enabled === "boolean"),
    "runtime.ttlMs": pick(envNumber("FLUPCODE_ADAPTIVE_PROBE_TTL_MS") !== undefined, positiveNumberFrom(probe.ttlMs) !== undefined),
    "runtime.override": pick(runtimeOverrideFrom(env.FLUPCODE_ADAPTIVE_RUNTIME) !== undefined, runtimeOverrideFrom(block.runtime) !== undefined),
    "episode.cadenceCalls": pick(
      envNumber("FLUPCODE_ADAPTIVE_EPISODE_CADENCE_CALLS") !== undefined,
      positiveNumberFrom(episode.cadenceCalls) !== undefined,
    ),
    "episode.sweepMs": pick(
      envNumber("FLUPCODE_ADAPTIVE_EPISODE_SWEEP_MS") !== undefined,
      positiveNumberFrom(episode.sweepMs) !== undefined,
    ),
    "episode.backfillMs": pick(
      envNumber("FLUPCODE_ADAPTIVE_EPISODE_BACKFILL_MS") !== undefined,
      positiveNumberFrom(episode.backfillMs) !== undefined,
    ),
    "episode.interactive": pick(
      env.FLUPCODE_ADAPTIVE_EPISODE_INTERACTIVE === "0",
      typeof episode.interactive === "boolean",
    ),
    "episode.idleMs": pick(
      envNumber("FLUPCODE_ADAPTIVE_EPISODE_IDLE_MS") !== undefined,
      positiveNumberFrom(episode.idleMs) !== undefined,
    ),
    "episode.sessionLimit": pick(
      envNumber("FLUPCODE_ADAPTIVE_EPISODE_SESSION_LIMIT") !== undefined,
      positiveNumberFrom(episode.sessionLimit) !== undefined,
    ),
  }
}

/**
 * The provenance of each provider's consent leaves. Jev without a `providers.jev` entry reads the
 * legacy keys (`jev.enabled`, `egress.projects`, `egress.kinds`), so their presence is its provenance.
 */
function providerSources(
  providers: Record<string, unknown>,
  jev: Record<string, unknown>,
  egress: Record<string, unknown>,
): Record<string, AdaptiveProvenance> {
  const legacy = isPlainObject(providers[LEGACY_EGRESS_PROVIDER])
    ? []
    : [
        [LEGACY_EGRESS_PROVIDER, { enabled: jev.enabled, projects: egress.projects, kinds: egress.kinds }] as const,
      ]
  const configured = Object.entries(providers).flatMap(([id, entry]) =>
    PROVIDER_ID_PATTERN.test(id) && isPlainObject(entry) ? [[id, entry] as const] : [],
  )
  return Object.fromEntries(
    [...legacy, ...configured].flatMap(([id, entry]) => [
      [`egress.providers.${id}.enabled`, typeof entry.enabled === "boolean" ? "block" : "default"],
      [`egress.providers.${id}.projects`, Array.isArray(entry.projects) ? "block" : "default"],
      [`egress.providers.${id}.kinds`, isPlainObject(entry.kinds) ? "block" : "default"],
    ]),
  )
}

// ---- reading (A3) ------------------------------------------------------------------------------

export type AdaptiveUsageView = {
  month: string
  tokensSpent: number
  calls: number
  monthlyTokens: number
  hotReserveFraction: number
}

export type AdaptiveConfigView = {
  effective: AdaptiveConfig
  source: Record<string, AdaptiveProvenance>
  /**
   * `typesafeKeyPresent` is true when either source has the predictive model's key; the source says
   * which, so the panel can tell a key the environment set from one it saved (ADR-0017, amended).
   */
  env: { adaptiveDisabled: boolean; typesafeKeyPresent: boolean; typesafeKeySource: ModelKeySource }
  /** Whether the panel can save the key: false without a vault key, when only the environment can. */
  modelKeyStorable: boolean
  /** `alerts` are the runtime changes not yet acknowledged (AH-D05), oldest first. */
  runtime: { runtime: RuntimeKind; degraded: boolean; checkedAt: number; alerts: RuntimeAlert[] }
  capabilities: RuntimeCapabilities
  canWrite: boolean
  writer: { path: string; exists: boolean }
  usage: AdaptiveUsageView
  writable: WritableField[]
  /** The model a learning draft is sent to (`provider/model`), or null when none is resolved. */
  learningDraft: { model: string | null }
  /**
   * The model assigned to classify finished sessions, or null when none is, and whether it may run
   * for at least one project. When it may not, reflection uses the built-in rules only (AH-F01).
   */
  learningClassifier: { model: string | null; ready: boolean }
  /** The learning caps reached right now by the projects learning worked on lately (AH-F03). */
  learningLimits: { reached: ProjectLimitHit[] }
  /**
   * The providers a consent row is shown for: every registered remote model, then any other provider
   * the config already names. A local model needs no consent and is not listed.
   */
  egressProviders: string[]
}

/** Whether a document already declares `flupcode.adaptive`, read with the same JSONC rules as writing. */
function declaresAdaptive(path: string): boolean {
  const text = tryReadConfigText(path)
  if (!text || !text.trim()) return false
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isPlainObject(parsed)) return false
  const flupcode = parsed.flupcode
  return isPlainObject(flupcode) && isPlainObject(flupcode.adaptive)
}

/**
 * The file a write lands in: the first candidate that already declares `flupcode.adaptive`, then the
 * first that exists, then the preferred name so a fresh config is created rather than a stranger's
 * file is appended to. The path is computed here, never taken from a request.
 */
export function writerTarget(directory = configDirectory()): { path: string; exists: boolean } {
  const candidates = CANDIDATE_NAMES.map((name) => join(directory, name))
  const path =
    candidates.find((candidate) => isFile(candidate) && declaresAdaptive(candidate)) ??
    candidates.find((candidate) => isFile(candidate)) ??
    candidates[0]!
  return { path, exists: isFile(path) }
}

export type AdaptiveConfigViewInput = {
  block: Record<string, unknown>
  env: NodeJS.ProcessEnv
  resolved: AdaptiveConfig
  runtime: { runtime: RuntimeKind; degraded: boolean; checkedAt: number }
  alerts?: RuntimeAlert[]
  capabilities: RuntimeCapabilities
  usage: AdaptiveUsageView
  canWrite: boolean
  writer: { path: string; exists: boolean }
  smallModel?: () => string | undefined
  models?: readonly EgressSubject[]
  learningLimits?: ProjectLimitHit[]
  /** Where the predictive model's key comes from; without it only the environment is read. */
  modelKey?: ModelKeyStatus
}

/** The read model, assembled from the raw block, the resolver and the calls the server already holds. */
export function adaptiveConfigView(input: AdaptiveConfigViewInput): AdaptiveConfigView {
  const env = input.env
  const draftModel = learningModel(input.resolved.learning, input.smallModel)
  const modelKey = input.modelKey ?? {
    source: typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim() !== "" ? "env" : "none",
    storable: false,
  }
  return {
    effective: input.resolved,
    source: adaptiveSource(input.block, env),
    env: {
      adaptiveDisabled: env.FLUPCODE_ADAPTIVE_DISABLED === "1",
      typesafeKeyPresent: modelKey.source !== "none",
      typesafeKeySource: modelKey.source,
    },
    modelKeyStorable: modelKey.storable,
    runtime: {
      runtime: input.runtime.runtime,
      degraded: input.runtime.degraded,
      checkedAt: input.runtime.checkedAt,
      alerts: input.alerts ?? [],
    },
    capabilities: input.capabilities,
    canWrite: input.canWrite,
    writer: input.writer,
    usage: input.usage,
    writable: [...WRITABLE_FIELDS],
    learningDraft: { model: draftModel ? `${draftModel.providerID}/${draftModel.id}` : null },
    learningClassifier: {
      model: input.resolved.models.skillReflection ?? null,
      ready: classifierReady(input.resolved, input.models),
    },
    learningLimits: { reached: input.learningLimits ?? [] },
    egressProviders: [
      ...new Set([
        ...(input.models ?? []).filter((model) => model.locality === "remote").map((model) => model.id),
        ...Object.keys(input.resolved.egress.providers),
      ]),
    ],
  }
}

// ---- planning a patch (A2, S2) -----------------------------------------------------------------

type PatchLeaf = { path: string; segments: string[]; value: unknown }

export type AdaptivePatchPlan = {
  leaves: PatchLeaf[]
  warnings: string[]
  blockAfter: Record<string, unknown>
}

export type PlanAdaptivePatchInput = {
  patch: Record<string, unknown>
  confirm: boolean
  block: Record<string, unknown>
  env: NodeJS.ProcessEnv
  adaptiveTokenPresent: boolean
  runtimeKind: RuntimeKind
  smallModel?: string | undefined
  /** The registered models, so a guard knows a local model needs no consent. */
  models?: readonly EgressSubject[]
}

/**
 * How deep a patch may nest before it is refused. Every writable leaf is at most four segments deep,
 * so anything past this is not a settings patch: it is a mistake or an attempt to make the walker
 * do unbounded work. A segment carrying a dot is refused separately — the official client nests,
 * and a literal `"budget.monthlyTokens"` key would be written as one key the resolver never reads.
 */
const MAX_PATCH_DEPTH = 8

/** Every leaf the patch names, a whole allowlisted subtree counting as one leaf (kinds, projects). */
function collectLeaves(patch: Record<string, unknown>): PatchLeaf[] {
  const leaves: PatchLeaf[] = []
  const walk = (value: unknown, prefix: string[]): void => {
    const path = prefix.join(".")
    if (prefix.length > 0 && writableFor(prefix)) {
      leaves.push({ path, segments: prefix, value })
      return
    }
    if (prefix.length < MAX_PATCH_DEPTH && isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [key, entry] of Object.entries(value)) walk(entry, [...prefix, key])
      return
    }
    leaves.push({ path, segments: prefix, value })
  }
  for (const [key, entry] of Object.entries(patch)) walk(entry, [key])
  return leaves
}

/** Whether a leaf is outside the allowlist, whether by its path or by a dotted segment in a key. */
const isRejectedLeaf = (leaf: PatchLeaf): boolean => writableFor(leaf.segments) === undefined

function validLeaf(field: WritableField, value: unknown): boolean {
  if (value === null) return true
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean"
    case "string-list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
    case "kinds":
      return isPlainObject(value) && Object.entries(value).every(([kind, on]) => isDecisionKind(kind) && typeof on === "boolean")
    case "number":
      return positiveNumberFrom(value) !== undefined
    case "count":
      return Number.isInteger(value) && positiveNumberFrom(value) !== undefined
    default:
      return false
  }
}

/** A deep copy of the block; the parsed value is the block's own JSON shape, so it stays a plain object. */
function cloneBlock(block: Record<string, unknown>): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(block))
  return isPlainObject(copy) ? copy : {}
}

/** Sets `value` at `segments`, deleting the key when `value` is `undefined`; creates missing objects. */
function setAt(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node = root
  for (const key of segments.slice(0, -1)) {
    const child = node[key]
    if (isPlainObject(child)) {
      node = child
      continue
    }
    const created: Record<string, unknown> = {}
    node[key] = created
    node = created
  }
  const last = segments[segments.length - 1]
  if (last === undefined) return
  if (value === undefined) delete node[last]
  else node[last] = value
}

/** The consent leaves a patch widens, per provider: a project added, or a kind turned on. */
function widenedConsent(before: AdaptiveConfig, after: AdaptiveConfig): string[] {
  return Object.entries(after.egress.providers).flatMap(([id, consent]) => {
    const previous = Object.hasOwn(before.egress.providers, id) ? before.egress.providers[id] : undefined
    const projects = new Set(previous?.projects ?? [])
    return [
      ...(consent.projects.some((project) => !projects.has(project)) ? [`egress.providers.${id}.projects`] : []),
      ...(decisionKinds().some((kind) => consent.kinds[kind] && !previous?.kinds[kind])
        ? [`egress.providers.${id}.kinds`]
        : []),
    ]
  })
}

/**
 * The leaves that move Jev's legacy consent into `egress.providers.jev` before a patch edits it.
 *
 * Once `providers.jev` exists the legacy keys stop granting anything, so writing only the leaf the
 * patch names would silently drop the rest of an old config's consent. Each leaf the patch does not
 * name is carried over as it resolves today, so the move itself changes no behaviour and the old keys
 * are left in the file untouched.
 */
function legacyConsentLeaves(leaves: readonly PatchLeaf[], block: Record<string, unknown>): PatchLeaf[] {
  const prefix = ["egress", "providers", LEGACY_EGRESS_PROVIDER]
  const touches = leaves.some((leaf) => prefix.every((segment, index) => leaf.segments[index] === segment))
  const egress = usageOf(block.egress)
  if (!touches || isPlainObject(usageOf(egress.providers)[LEGACY_EGRESS_PROVIDER])) return []
  const legacy = legacyEgressProvider(block)
  const carried = {
    enabled: legacy.enabled,
    projects: legacy.projects,
    kinds: Object.fromEntries(Object.entries(legacy.kinds).filter(([, on]) => on)),
  }
  return Object.entries(carried).flatMap(([key, value]) => {
    const segments = [...prefix, key]
    const path = segments.join(".")
    return leaves.some((leaf) => leaf.path === path) ? [] : [{ path, segments, value }]
  })
}

/**
 * Whether the model assigned to `skillReflection` may classify a session for at least one project,
 * read as the egress guard reads it at call time: a local model needs no consent, a remote one needs
 * its own provider's switch, a project and the kind. Only informative: the call itself is gated again
 * per project by the egress guard, and learning without a classifier runs on the built-in rules.
 */
function classifierReady(config: AdaptiveConfig, models: readonly EgressSubject[] | undefined): boolean {
  const id = config.models.skillReflection
  if (id === undefined) return false
  if (models?.find((model) => model.id === id)?.locality === "local") return true
  const consent = Object.hasOwn(config.egress.providers, id) ? config.egress.providers[id] : undefined
  return consent !== undefined && consent.enabled && consent.projects.length > 0 && consent.kinds.skillReflection === true
}

/**
 * Turns a patch into the leaf edits to write, or throws the rejection the contract reports.
 *
 * Order of refusal: an unknown field, then an invalid value, then the environmental guard, then the
 * allowlist guards, then confirmation. Guards read the effective config after the patch, so a value
 * already present in the block satisfies them.
 */
export function planAdaptivePatch(input: PlanAdaptivePatchInput): AdaptivePatchPlan {
  const leaves = collectLeaves(input.patch)
  const unsupported = leaves.filter(isRejectedLeaf).map((leaf) => leaf.path)
  if (unsupported.length > 0)
    throw new AdaptiveConfigError("The patch names fields this surface does not write", 422, "unsupported-field", unsupported)

  const invalid = leaves
    .filter((leaf) => !validLeaf(writableFor(leaf.segments)!, leaf.value))
    .map((leaf) => leaf.path)
  if (invalid.length > 0)
    throw new AdaptiveConfigError("A patch value does not match its field", 422, "invalid-value", invalid)

  const written = [...legacyConsentLeaves(leaves, input.block), ...leaves]
  const blockAfter = cloneBlock(input.block)
  for (const leaf of written) setAt(blockAfter, leaf.segments, leaf.value === null ? undefined : leaf.value)

  const effectiveBefore = resolveAdaptiveConfig({ block: input.block, env: input.env })
  const effectiveAfter = resolveAdaptiveConfig({ block: blockAfter, env: input.env })

  const setsTrue = (path: string): boolean => leaves.some((leaf) => leaf.path === path && leaf.value === true)
  const consentsTurnedOn = leaves.filter(
    (leaf) => leaf.segments[0] === "egress" && leaf.segments[3] === "enabled" && leaf.value === true,
  )

  if (setsTrue("enabled") && input.env.FLUPCODE_ADAPTIVE_DISABLED === "1")
    throw new AdaptiveConfigError("Adaptive is disabled by FLUPCODE_ADAPTIVE_DISABLED=1", 422, "env-disabled", ["enabled"])

  if (setsTrue("relevance.enabled") && !input.adaptiveTokenPresent)
    throw new AdaptiveConfigError("Enabling relevance needs a resolved adaptive token", 422, "guard:no-adaptive-token", [
      "relevance.enabled",
    ])

  if (setsTrue("guardrails.enabled") && !input.adaptiveTokenPresent)
    throw new AdaptiveConfigError("Enabling guardrails needs a resolved adaptive token", 422, "guard:no-adaptive-token", [
      "guardrails.enabled",
    ])

  if (setsTrue("selection.enabled") && !input.adaptiveTokenPresent)
    throw new AdaptiveConfigError("Enabling per-step selection needs a resolved adaptive token", 422, "guard:no-adaptive-token", [
      "selection.enabled",
    ])

  if (setsTrue("toolTrim.enabled") && !input.adaptiveTokenPresent)
    throw new AdaptiveConfigError("Enabling the tool-output trim needs a resolved adaptive token", 422, "guard:no-adaptive-token", [
      "toolTrim.enabled",
    ])

  if (setsTrue("jev.enabled")) {
    const missing = missingConsent(effectiveAfter, LEGACY_EGRESS_PROVIDER, true)
    if (missing.length > 0)
      throw new AdaptiveConfigError(
        "Enabling Jev needs Jev's egress consent",
        422,
        "guard:egress-allowlist-required",
        ["jev.enabled"],
        missing,
      )
  }

  for (const leaf of consentsTurnedOn) {
    const id = leaf.segments[2]!
    const missing = missingConsent(effectiveAfter, id, false)
    if (missing.length > 0)
      throw new AdaptiveConfigError(
        `Consenting to ${id} needs a project and a kind for it`,
        422,
        "guard:egress-allowlist-required",
        [leaf.path],
        missing,
      )
  }

  const confirmFields: string[] = []
  if (setsTrue("retention.enabled")) confirmFields.push("retention.enabled")
  if (setsTrue("learning.enabled")) confirmFields.push("learning.enabled")
  if (setsTrue("jev.enabled")) confirmFields.push("jev.enabled")
  confirmFields.push(...consentsTurnedOn.map((leaf) => leaf.path))
  confirmFields.push(...widenedConsent(effectiveBefore, effectiveAfter))
  if (confirmFields.length > 0 && !input.confirm)
    throw new AdaptiveConfigError("This change needs confirmation", 422, "confirmation-required", confirmFields)

  const warnings: string[] = []
  if (setsTrue("context.apply") || setsTrue("selection.enabled")) warnings.push("evaluation-gated")
  if (setsTrue("selection.enabled") && input.runtimeKind !== "legacy") warnings.push("runtime-inert")
  if (setsTrue("relevance.enabled") && input.runtimeKind !== "legacy") warnings.push("runtime-inert")
  // Learning needs no classifier consent: without a classifier that may run, reflection uses the
  // built-in rules (AH-F01), which draft nothing, so a missing drafting model is only worth saying
  // on the model path.
  const classifier = setsTrue("learning.enabled") && classifierReady(effectiveAfter, input.models)
  if (setsTrue("learning.enabled")) warnings.push("learning-draft-egress")
  if (setsTrue("learning.enabled") && !classifier) warnings.push("classifier-no-consent")
  if (classifier && !effectiveAfter.learning.model && !input.smallModel) warnings.push("no-model")
  if (setsTrue("enabled")) warnings.push("skills-still-load")

  return { leaves: written, warnings, blockAfter }
}

/** The consent leaves a provider still lacks: a project, a kind and, when asked, the switch itself. */
function missingConsent(config: AdaptiveConfig, id: string, needsEnabled: boolean): string[] {
  const consent = Object.hasOwn(config.egress.providers, id) ? config.egress.providers[id] : undefined
  return [
    ...(needsEnabled && !consent?.enabled ? [`egress.providers.${id}.enabled`] : []),
    ...(!consent || consent.projects.length === 0 ? [`egress.providers.${id}.projects`] : []),
    ...(!consent || !Object.values(consent.kinds).some(Boolean) ? [`egress.providers.${id}.kinds`] : []),
  ]
}

/** Applies every leaf edit in order; a later leaf is positioned against the text the earlier one left. */
function applyLeafEdits(text: string, leaves: PatchLeaf[]): string {
  return leaves.reduce((acc, leaf) => {
    const value = leaf.value === null ? undefined : leaf.value
    return applyEdits(acc, modify(acc, ["flupcode", "adaptive", ...leaf.segments], value, { formattingOptions: FORMAT }))
  }, text)
}

/** Maps a low-level write failure onto the codes this surface's contract reports. */
function writeFailure(cause: unknown): unknown {
  if (cause instanceof ConfigWriteError) {
    const code = cause.code === "config_unreadable" ? "config-unreadable" : cause.code === "invalid_config" ? "invalid-config" : cause.code
    return new AdaptiveConfigError(cause.message, cause.status, code)
  }
  return cause
}

// ---- the service -------------------------------------------------------------------------------

export type AdaptiveConfigSurfaceDeps = {
  config: { current(): AdaptiveConfig; raw(): Record<string, unknown>; invalidate(): void }
  runtime: () => { runtime: RuntimeKind; degraded: boolean; checkedAt: number }
  /** The probe's unacknowledged runtime changes (AH-D05); none when the probe is not wired. */
  alerts?: () => RuntimeAlert[]
  capabilities: () => RuntimeCapabilities
  repository: AdaptiveUsageRepository
  canWrite: boolean
  adaptiveTokenPresent: boolean
  env?: NodeJS.ProcessEnv
  smallModel?: () => string | undefined
  /** The registered predictive models: the view lists the remote ones for consent. */
  models?: readonly EgressSubject[]
  /** The learning caps reached right now (AH-F03); none when the learning loop is not wired. */
  learningLimits?: () => ProjectLimitHit[]
  /** Where the predictive model's key comes from, read live (ADR-0017, amended). */
  modelKey?: () => ModelKeyStatus
  now?: () => number
}

export type AdaptiveConfigUpdate = { view: AdaptiveConfigView; warnings: string[] }

export type AdaptiveConfigSurface = {
  read(): AdaptiveConfigView
  update(patch: Record<string, unknown>, confirm: boolean): Promise<AdaptiveConfigUpdate>
}

/** The one read/write surface the HTTP layer delegates to; it holds no HTTP shape of its own. */
export function createAdaptiveConfigSurface(deps: AdaptiveConfigSurfaceDeps): AdaptiveConfigSurface {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now

  const read = (): AdaptiveConfigView => {
    const resolved = deps.config.current()
    const usage = deps.repository.adaptiveUsage(budgetMonth(now()))
    return adaptiveConfigView({
      block: deps.config.raw(),
      env,
      resolved,
      runtime: deps.runtime(),
      ...(deps.alerts ? { alerts: deps.alerts() } : {}),
      capabilities: deps.capabilities(),
      usage: {
        month: budgetMonth(now()),
        tokensSpent: usage.tokens,
        calls: usage.calls,
        monthlyTokens: resolved.budget.monthlyTokens,
        hotReserveFraction: resolved.budget.hotReserveFraction,
      },
      canWrite: deps.canWrite,
      writer: writerTarget(),
      ...(deps.smallModel ? { smallModel: deps.smallModel } : {}),
      ...(deps.models ? { models: deps.models } : {}),
      ...(deps.learningLimits ? { learningLimits: deps.learningLimits() } : {}),
      ...(deps.modelKey ? { modelKey: deps.modelKey() } : {}),
    })
  }

  const update = async (patch: Record<string, unknown>, confirm: boolean): Promise<AdaptiveConfigUpdate> => {
    const plan = planAdaptivePatch({
      patch,
      confirm,
      block: deps.config.raw(),
      env,
      adaptiveTokenPresent: deps.adaptiveTokenPresent,
      runtimeKind: deps.runtime().runtime,
      smallModel: deps.smallModel?.(),
      ...(deps.models ? { models: deps.models } : {}),
    })
    // A patch with no leaves is a read: it must not create or rewrite the file just to say so.
    if (plan.leaves.length === 0) return { view: read(), warnings: plan.warnings }
    try {
      await applyEditsToFile(writerTarget().path, (text) => applyLeafEdits(text, plan.leaves))
    } catch (cause) {
      throw writeFailure(cause)
    }
    // The next read sees the new bytes instead of waiting out the TTL.
    deps.config.invalidate()
    return { view: read(), warnings: plan.warnings }
  }

  return { read, update }
}
