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
import { resolveAdaptiveConfig } from "./config"
import type { AdaptiveConfig } from "./config"
import { decisionKinds, isDecisionKind } from "./decision"
import { budgetMonth } from "./providers/budget"
import { learningModel } from "./learning/draft"
import type { RuntimeCapabilities, RuntimeKind } from "./runtime"

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

export type AdaptiveFieldType = "boolean" | "string-list" | "kinds" | "number"
export type AdaptiveConfirmation = "none" | "required" | "widening"
export type AdaptiveGuard = "none" | "env-disabled" | "adaptive-token" | "egress-allowlist"
export type AdaptiveWarning =
  | "evaluation-gated"
  | "runtime-inert"
  | "no-model"
  | "skills-still-load"
  | "learning-draft-egress"

/** One switch the settings panel may render; the list is the whole allowlist. */
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
  {
    path: "learning.enabled",
    type: "boolean",
    confirmation: "required",
    guard: "egress-allowlist",
    warning: "learning-draft-egress",
  },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "guardrails.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
  { path: "budget.monthlyTokens", type: "number", confirmation: "none", guard: "none" },
]

const WRITABLE_BY_PATH = new Map(WRITABLE_FIELDS.map((field) => [field.path, field]))

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
  const relevance = usageOf(block.relevance)
  const guardrails = usageOf(block.guardrails)
  const jev = usageOf(block.jev)
  const retention = usageOf(block.retention)
  const egress = usageOf(block.egress)
  const budget = usageOf(block.budget)
  const pick = (fromEnv: boolean, fromBlock: boolean): AdaptiveProvenance => (fromEnv ? "env" : fromBlock ? "block" : "default")
  const envNumber = (name: string) => positiveNumberFrom(Number(env[name]))
  return {
    enabled: pick(env.FLUPCODE_ADAPTIVE_DISABLED === "1", typeof block.enabled === "boolean"),
    shadow: pick(false, typeof block.shadow === "boolean"),
    "context.enabled": pick(false, typeof context.enabled === "boolean"),
    "context.apply": pick(false, typeof context.apply === "boolean"),
    "learning.enabled": pick(false, typeof learning.enabled === "boolean"),
    "relevance.enabled": pick(false, typeof relevance.enabled === "boolean"),
    "guardrails.enabled": pick(false, typeof guardrails.enabled === "boolean"),
    "jev.enabled": pick(false, typeof jev.enabled === "boolean"),
    "retention.enabled": pick(false, typeof retention.enabled === "boolean"),
    "egress.projects": pick(false, Array.isArray(egress.projects)),
    "egress.kinds": pick(false, isPlainObject(egress.kinds)),
    "budget.monthlyTokens": pick(false, positiveNumberFrom(budget.monthlyTokens) !== undefined),
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
  env: { adaptiveDisabled: boolean; typesafeKeyPresent: boolean }
  runtime: { runtime: RuntimeKind; degraded: boolean; checkedAt: number }
  capabilities: RuntimeCapabilities
  canWrite: boolean
  writer: { path: string; exists: boolean }
  usage: AdaptiveUsageView
  writable: WritableField[]
  /** The model a learning draft is sent to (`provider/model`), or null when none is resolved. */
  learningDraft: { model: string | null }
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
  capabilities: RuntimeCapabilities
  usage: AdaptiveUsageView
  canWrite: boolean
  writer: { path: string; exists: boolean }
  smallModel?: () => string | undefined
}

/** The read model, assembled from the raw block, the resolver and the calls the server already holds. */
export function adaptiveConfigView(input: AdaptiveConfigViewInput): AdaptiveConfigView {
  const env = input.env
  const draftModel = learningModel(input.resolved.learning, input.smallModel)
  return {
    effective: input.resolved,
    source: adaptiveSource(input.block, env),
    env: {
      adaptiveDisabled: env.FLUPCODE_ADAPTIVE_DISABLED === "1",
      typesafeKeyPresent: typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim() !== "",
    },
    runtime: { runtime: input.runtime.runtime, degraded: input.runtime.degraded, checkedAt: input.runtime.checkedAt },
    capabilities: input.capabilities,
    canWrite: input.canWrite,
    writer: input.writer,
    usage: input.usage,
    writable: [...WRITABLE_FIELDS],
    learningDraft: { model: draftModel ? `${draftModel.providerID}/${draftModel.id}` : null },
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
}

/**
 * How deep a patch may nest before it is refused. Every writable leaf is at most two segments deep,
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
    const writable =
      prefix.length > 0 && prefix.every((segment) => !segment.includes(".")) && WRITABLE_BY_PATH.has(path)
    if (writable) {
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
const isRejectedLeaf = (leaf: PatchLeaf): boolean =>
  !WRITABLE_BY_PATH.has(leaf.path) || leaf.segments.some((segment) => segment.includes("."))

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

const widensProjects = (before: AdaptiveConfig, after: AdaptiveConfig): boolean => {
  const previous = new Set(before.egress.projects)
  return after.egress.projects.some((project) => !previous.has(project))
}

const widensKinds = (before: AdaptiveConfig, after: AdaptiveConfig): boolean =>
  decisionKinds().some((kind) => after.egress.kinds[kind] && !before.egress.kinds[kind])

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
    .filter((leaf) => !validLeaf(WRITABLE_BY_PATH.get(leaf.path)!, leaf.value))
    .map((leaf) => leaf.path)
  if (invalid.length > 0)
    throw new AdaptiveConfigError("A patch value does not match its field", 422, "invalid-value", invalid)

  const blockAfter = cloneBlock(input.block)
  for (const leaf of leaves) setAt(blockAfter, leaf.segments, leaf.value === null ? undefined : leaf.value)

  const effectiveBefore = resolveAdaptiveConfig({ block: input.block, env: input.env })
  const effectiveAfter = resolveAdaptiveConfig({ block: blockAfter, env: input.env })

  const setsTrue = (path: string): boolean => leaves.some((leaf) => leaf.path === path && leaf.value === true)

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

  if (setsTrue("learning.enabled")) {
    const missing: string[] = []
    if (effectiveAfter.egress.projects.length === 0) missing.push("egress.projects")
    if (!effectiveAfter.egress.kinds.skillReflection) missing.push("egress.kinds.skillReflection")
    if (missing.length > 0)
      throw new AdaptiveConfigError(
        "Enabling learning needs an egress allowlist for the project and skillReflection",
        422,
        "guard:egress-allowlist-required",
        ["learning.enabled"],
        missing,
      )
  }

  if (setsTrue("jev.enabled")) {
    const missing: string[] = []
    if (effectiveAfter.egress.projects.length === 0) missing.push("egress.projects")
    if (!Object.values(effectiveAfter.egress.kinds).some(Boolean)) missing.push("egress.kinds")
    if (missing.length > 0)
      throw new AdaptiveConfigError(
        "Enabling Jev needs an egress allowlist",
        422,
        "guard:egress-allowlist-required",
        ["jev.enabled"],
        missing,
      )
  }

  const confirmFields: string[] = []
  if (setsTrue("retention.enabled")) confirmFields.push("retention.enabled")
  if (setsTrue("learning.enabled")) confirmFields.push("learning.enabled")
  if (setsTrue("jev.enabled")) confirmFields.push("jev.enabled")
  if (widensProjects(effectiveBefore, effectiveAfter)) confirmFields.push("egress.projects")
  if (widensKinds(effectiveBefore, effectiveAfter)) confirmFields.push("egress.kinds")
  if (confirmFields.length > 0 && !input.confirm)
    throw new AdaptiveConfigError("This change needs confirmation", 422, "confirmation-required", confirmFields)

  const warnings: string[] = []
  if (setsTrue("context.apply")) warnings.push("evaluation-gated")
  if (setsTrue("relevance.enabled") && input.runtimeKind !== "legacy") warnings.push("runtime-inert")
  if (setsTrue("learning.enabled")) warnings.push("learning-draft-egress")
  if (setsTrue("learning.enabled") && !effectiveAfter.learning.model && !input.smallModel) warnings.push("no-model")
  if (setsTrue("enabled")) warnings.push("skills-still-load")

  return { leaves, warnings, blockAfter }
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
  capabilities: () => RuntimeCapabilities
  repository: AdaptiveUsageRepository
  canWrite: boolean
  adaptiveTokenPresent: boolean
  env?: NodeJS.ProcessEnv
  smallModel?: () => string | undefined
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
