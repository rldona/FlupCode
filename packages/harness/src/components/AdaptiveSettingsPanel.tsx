import { For, Show, createEffect, createSignal, type Component, type JSX } from "solid-js"
import { getLocale, t } from "../i18n"
import { adaptiveSurfaces } from "../client"
import { modelDisplayName } from "../adaptive-copy"
import type { AdaptiveConfigError } from "../client"
import type {
  AdaptiveConfigView,
  AdaptiveLearningLimitHit,
  AdaptiveModel,
  AdaptiveRuntimeAlert,
  AdaptiveProvenance,
  AdaptiveProviderConsent,
  AdaptiveWritableField,
  ValueGateSnapshot,
  ValueGateState,
} from "../types"
import { Toggle } from "./Toggle"
import { ConfirmDialog } from "./ConfirmDialog"
import { Segmented } from "./Segmented"
import { failureDetail } from "./PanelBoundary"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The decision kinds an older server that does not serve its registry is shown with. */
export const ADAPTIVE_KINDS = ["completion", "skillRelevance", "contextItem", "skillReflection"] as const

/** Why a switch cannot be offered, with the words the panel shows. */
export type AdaptiveProblem = "env-disabled" | "no-adaptive-token" | "egress-allowlist"

/**
 * The fields a patch may carry, as the server's own descriptors allow.
 *
 * Exported so a test can pin the panel to the contract: a switch the server does not list is never
 * drawn, and the whole allowlist stays server-owned.
 */
export function writableField(view: AdaptiveConfigView, path: string): AdaptiveWritableField | undefined {
  const consent = consentPath(path)
  const wanted = consent ? `egress.providers.*.${consent.leaf}` : path.startsWith("models.") ? "models.*" : path
  return view.writable.find((field) => field.path === wanted)
}

/**
 * The name a reader is shown for a model or provider id, as the server's registry says it, translated
 * when the app knows the words. An id the registry does not name (an older server, or a provider only
 * the config file mentions) is shown as it is.
 */
export function modelName(view: AdaptiveConfigView, id: string): string {
  return modelDisplayName(id, view.models ?? [])
}

/**
 * The decision kinds a model can be assigned to, and a provider asked about: every kind some registered
 * model answers, in the order of their plain names, then any kind this build has no name for yet. An
 * older server that does not serve its registry is shown the four kinds it shipped with.
 */
export function modelKinds(view: AdaptiveConfigView): string[] {
  const models = view.models
  if (!models) return [...ADAPTIVE_KINDS]
  const supported = new Set(models.flatMap((model) => model.supports))
  return [
    ...Object.keys(KIND_LABELS).filter((kind) => supported.has(kind)),
    ...[...supported].filter((kind) => !Object.hasOwn(KIND_LABELS, kind)),
  ]
}

/** The registered models that can answer a kind, for its selector. */
export function assignableModels(view: AdaptiveConfigView, kind: string): AdaptiveModel[] {
  return (view.models ?? []).filter((model) => model.supports.includes(kind))
}

/**
 * The model that answers a kind, or undefined for none. The server resolves the legacy `jev.enabled`
 * into `effective.models` (every kind the block does not name asks Jev), so this is the effective
 * assignment either way.
 */
export function assignedModel(view: AdaptiveConfigView, kind: string): string | undefined {
  const models = view.effective.models ?? {}
  const id = Object.hasOwn(models, kind) ? models[kind] : undefined
  return typeof id === "string" ? id : undefined
}

/**
 * The leaves choosing a model for a kind writes; null is none. While the legacy `jev.enabled` is on it
 * assigns Jev to every kind without an entry, so the first choice writes the whole effective assignment
 * as an explicit `models` block and turns `jev.enabled` off in the same patch: the two never disagree,
 * and no kind changes but the one chosen.
 */
export function assignmentLeaves(view: AdaptiveConfigView, kind: string, id: string | null): Record<string, unknown> {
  if (!view.effective.jev.enabled) return { [`models.${kind}`]: id }
  return {
    ...Object.fromEntries(Object.entries(view.effective.models ?? {}).map(([entry, model]) => [`models.${entry}`, model])),
    [`models.${kind}`]: id,
    "jev.enabled": false,
  }
}

/**
 * What a kind's model still needs before it can answer, in the order its provider's section draws it:
 * a project, this decision, sending data turned on, then the key. A local model needs no consent.
 */
export function missingForKind(view: AdaptiveConfigView, kind: string, id: string): MissingItem[] {
  const model = view.models?.find((entry) => entry.id === id)
  const provider = modelName(view, id)
  const consent = consentOf(view, id)
  const needsConsent = model?.needsConsent ?? true
  return [
    ...(needsConsent && (consent?.projects.length ?? 0) === 0 ? [{ key: "a project" }] : []),
    ...(needsConsent && consent?.kinds[kind] !== true
      ? [{ key: "this decision allowed for {provider}", params: { provider } }]
      : []),
    ...(needsConsent && consent?.enabled !== true
      ? [{ key: "sending data to {provider} turned on", params: { provider } }]
      : []),
    ...(model?.needsKey === true && !view.env.typesafeKeyPresent ? [{ key: "the model key" }] : []),
  ]
}

/** The provider and leaf of a consent path (`egress.providers.<id>.<leaf>`), or undefined. */
export function consentPath(path: string): { provider: string; leaf: string } | undefined {
  const [root, group, provider, leaf, ...rest] = path.split(".")
  if (root !== "egress" || group !== "providers" || !provider || !leaf || rest.length > 0) return undefined
  return { provider, leaf }
}

/** One provider's resolved consent, or undefined when the server reports none for it. */
export function consentOf(view: AdaptiveConfigView, provider: string): AdaptiveProviderConsent | undefined {
  const providers = view.effective.egress.providers
  return Object.hasOwn(providers, provider) ? providers[provider] : undefined
}

/** The providers a consent row is drawn for: the server's list, else every provider it resolved. */
export function consentProviders(view: AdaptiveConfigView): string[] {
  return view.egressProviders ?? Object.keys(view.effective.egress.providers)
}

/**
 * Whether a field's guard can be met right now.
 *
 * The server evaluates the guards on the effective config *after* the patch, so this mirrors the
 * parts a single switch cannot change: the environment, the acting token (announced by the
 * `adaptive-relevance` and `adaptive-guardrails` capabilities, both only when the server resolved it)
 * and the provider consent the switch itself needs. A switch whose guard already fails is drawn
 * disabled with the reason, never as a control that would only 422. `path` is the concrete leaf, for a
 * consent descriptor whose own path names its provider as `*`.
 */
export function fieldProblem(
  field: AdaptiveWritableField,
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  path = field.path,
): AdaptiveProblem | undefined {
  if (field.guard === "env-disabled" && view.env.adaptiveDisabled) return "env-disabled"
  if (
    field.guard === "adaptive-token" &&
    !capabilities.includes("adaptive-relevance") &&
    !capabilities.includes("adaptive-guardrails")
  )
    return "no-adaptive-token"
  if (field.guard !== "egress-allowlist") return undefined
  const ready = (provider: string, needsEnabled: boolean) => {
    const consent = consentOf(view, provider)
    if (!consent || consent.projects.length === 0 || (needsEnabled && !consent.enabled)) return false
    return Object.values(consent.kinds).some(Boolean)
  }
  if (path === "jev.enabled") return ready("jev", true) ? undefined : "egress-allowlist"
  const consent = consentPath(path)
  if (consent && !ready(consent.provider, false)) return "egress-allowlist"
  return undefined
}

/** The reason a guard shows, as an i18n key; undefined when the guard is satisfied. */
export function problemKey(problem: AdaptiveProblem): string {
  if (problem === "env-disabled") return "Turned off by the environment."
  if (problem === "no-adaptive-token") return "This server was started without permission to act on sessions."
  return "First allow sharing data with the model provider, for a project and a decision."
}

/** One thing a switch still needs, as a template for `t` and its holes. */
export type MissingItem = { key: string; params?: Record<string, string> }

/**
 * Exactly what the predictive model's switch, or a provider's "Send data" switch, still needs, in the
 * order the section draws it: a project, a decision, sending data turned on, then the key. Empty when
 * nothing is missing, or for any other switch. The key is not a server guard — without it built-in
 * rules decide — but a switch that could only wait for it is not offered until it is set.
 */
export function missingFor(view: AdaptiveConfigView, path: string): MissingItem[] {
  const consent = consentPath(path)
  const provider = path === "jev.enabled" ? "jev" : consent?.leaf === "enabled" ? consent.provider : undefined
  if (provider === undefined) return []
  const current = consentOf(view, provider)
  return [
    ...((current?.projects.length ?? 0) === 0 ? [{ key: "a project" }] : []),
    ...(Object.values(current?.kinds ?? {}).some(Boolean) ? [] : [{ key: "a decision" }]),
    ...(path === "jev.enabled" && current?.enabled !== true
      ? [{ key: "sending data to {provider} turned on", params: { provider: modelName(view, provider) } }]
      : []),
    ...(path === "jev.enabled" && !view.env.typesafeKeyPresent ? [{ key: "the model key" }] : []),
  ]
}

/** The missing items said as one sentence, joined the way the reader's language joins a list. */
export function missingText(items: readonly MissingItem[]): string {
  const list = new Intl.ListFormat(getLocale(), { type: "conjunction" })
  return t("Missing: {fields}", { fields: list.format(items.map((item) => t(item.key, item.params))) })
}

/**
 * Where the predictive model's key stands: set by the environment (read-only here), saved in the
 * encrypted vault, missing, or missing on a machine that cannot store one. An older server that does
 * not say the source is read from the presence flag alone.
 */
export type ModelKeyState = "env" | "stored" | "none" | "unavailable"

export function modelKeyState(view: AdaptiveConfigView): ModelKeyState {
  const source = view.env.typesafeKeySource ?? (view.env.typesafeKeyPresent ? "env" : "none")
  if (source !== "none") return source
  return view.modelKeyStorable === true ? "none" : "unavailable"
}

/** The switches the master `enabled` stops on the server; retention sweeps run regardless of it. */
const MASTER_GATED = new Set([
  "shadow",
  "context.enabled",
  "context.apply",
  "learning.enabled",
  "relevance.enabled",
  "guardrails.enabled",
  "jev.enabled",
])

/**
 * Whether a switch is inert because the master switch is off. Its own value is kept and still shown,
 * so the panel says it is inactive instead of letting a bare "on" suggest it acts.
 */
export function inactiveByMaster(view: AdaptiveConfigView, path: string): boolean {
  return !view.effective.enabled && MASTER_GATED.has(path)
}

/** Whether a boolean leaf is on in the effective config, read by its dotted path. */
export function leafOn(view: AdaptiveConfigView, path: string): boolean {
  const consent = consentPath(path)
  if (consent) return consent.leaf === "enabled" && consentOf(view, consent.provider)?.enabled === true
  const found = path
    .split(".")
    .reduce<unknown>(
      (node, key) => (isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined),
      view.effective,
    )
  return found === true
}

// ---- levels and capability cards (AH-E01) ------------------------------------------------------

/** The top-level level: the kill switch, two presets, and whatever else the switches say. */
export type AdaptiveLevel = "off" | "observe" | "assist" | "custom"

export const ADAPTIVE_LEVELS: readonly AdaptiveLevel[] = ["off", "observe", "assist", "custom"]

/**
 * What each level writes, as the leaves of one nested patch; the server contract is unchanged.
 *
 * `off` writes only the master switch: it is the kill switch, so every child keeps its value and
 * nothing is deleted (ADR-0022). The presets never write a switch that needs a confirmation or sends
 * data off the machine — learning, the predictive model, retention, provider consent — so choosing a
 * level never opens a dialog and those stay the reader's own opt-in. `context.apply` stays off in both:
 * acting on the context waits for the offline evaluation. `custom` is derived, never a preset: from
 * `off` it only turns the master back on, keeping whatever the switches were.
 */
export const LEVEL_PRESETS = {
  off: { enabled: false },
  observe: {
    enabled: true,
    shadow: true,
    "context.enabled": true,
    "context.apply": false,
    "relevance.enabled": false,
    "guardrails.enabled": false,
  },
  assist: {
    enabled: true,
    shadow: true,
    "context.enabled": true,
    "context.apply": false,
    "relevance.enabled": true,
    "guardrails.enabled": true,
  },
  custom: { enabled: true },
} satisfies Record<AdaptiveLevel, Record<string, boolean>>

/** The leaves a level writes, narrowed to the ones the server lists as writable. */
export function levelLeaves(view: AdaptiveConfigView, level: AdaptiveLevel): Record<string, boolean> {
  return Object.fromEntries(Object.entries(LEVEL_PRESETS[level]).filter(([path]) => writableField(view, path)))
}

/**
 * The level the switches are at: `off` whenever the master is off, a preset when every writable leaf
 * it names matches, and `custom` otherwise. Observe is checked first so a server that lists neither
 * acting switch reads as the quieter level.
 */
export function currentLevel(view: AdaptiveConfigView): AdaptiveLevel {
  if (!view.effective.enabled) return "off"
  const matches = (level: AdaptiveLevel) =>
    Object.entries(levelLeaves(view, level)).every(([path, on]) => leafOn(view, path) === on)
  if (matches("observe")) return "observe"
  if (matches("assist")) return "assist"
  return "custom"
}

/** Why a level cannot be chosen right now: a leaf it turns on whose guard already fails. */
export function levelProblem(
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  level: AdaptiveLevel,
): AdaptiveProblem | undefined {
  if (level === "off") return undefined
  if (view.env.adaptiveDisabled) return "env-disabled"
  return leavesProblem(view, capabilities, levelLeaves(view, level))
}

function leavesProblem(
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  leaves: Record<string, boolean>,
): AdaptiveProblem | undefined {
  return Object.entries(leaves).flatMap(([path, on]) => {
    const field = writableField(view, path)
    const problem = on && field ? fieldProblem(field, view, capabilities, path) : undefined
    return problem ? [problem] : []
  })[0]
}

export type CapabilityID = "context" | "suggestions" | "loops" | "learning"

/** One state a capability card offers, and the leaves choosing it writes. The first is always off. */
export type CapabilityChoice = { id: string; label: string; leaves: Record<string, boolean> }

export type Capability = {
  id: CapabilityID
  title: string
  description: string
  /** The switch that says whether the capability is on at all; the card exists only when it is writable. */
  leaf: string
  choices: CapabilityChoice[]
}

/** The four capabilities of §7.4, each over the existing switches. */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "context",
    title: "Context",
    description: "Works out which earlier parts of the conversation the agent still needs.",
    leaf: "context.enabled",
    choices: [
      { id: "off", label: "Off", leaves: { "context.enabled": false, "context.apply": false } },
      { id: "observing", label: "Observing", leaves: { "context.enabled": true, "context.apply": false } },
      { id: "acting", label: "Acting*", leaves: { "context.enabled": true, "context.apply": true } },
    ],
  },
  {
    id: "suggestions",
    title: "Skill suggestion",
    description: "Points the agent to the skills that fit the task.",
    leaf: "relevance.enabled",
    choices: [
      { id: "off", label: "Off", leaves: { "relevance.enabled": false } },
      { id: "suggesting", label: "Suggesting", leaves: { "relevance.enabled": true } },
    ],
  },
  {
    id: "loops",
    title: "Loop warnings",
    description: "Warns you when the agent repeats the same step. It never pauses the turn.",
    leaf: "guardrails.enabled",
    choices: [
      { id: "off", label: "Off", leaves: { "guardrails.enabled": false } },
      { id: "warning", label: "Warning", leaves: { "guardrails.enabled": true } },
    ],
  },
  {
    id: "learning",
    title: "Learning",
    description: "Proposes new skills from finished sessions. Nothing is installed without your approval.",
    leaf: "learning.enabled",
    choices: [
      { id: "off", label: "Off", leaves: { "learning.enabled": false } },
      { id: "proposing", label: "Proposing", leaves: { "learning.enabled": true } },
    ],
  },
]

/**
 * The choices a card draws, from the server's list: a choice that turns on a leaf the server does not
 * list is dropped, and a leaf it only turns off is left out of the patch rather than refused.
 */
export function capabilityChoices(view: AdaptiveConfigView, capability: Capability): CapabilityChoice[] {
  return capability.choices.flatMap((choice) => {
    const entries = Object.entries(choice.leaves)
    if (entries.some(([path, on]) => on && !writableField(view, path))) return []
    return [{ ...choice, leaves: Object.fromEntries(entries.filter(([path]) => writableField(view, path))) }]
  })
}

/** The choice the switches are at: off while the capability's own switch is off. */
export function capabilityChoice(view: AdaptiveConfigView, capability: Capability): string {
  const choices = capabilityChoices(view, capability)
  if (!leafOn(view, capability.leaf)) return "off"
  const on = choices.slice(1)
  const matched = on.find((choice) =>
    Object.entries(choice.leaves).every(([path, value]) => leafOn(view, path) === value),
  )
  return (matched ?? on[0])?.id ?? "off"
}

/** Why a card's choice cannot be picked right now, from the guards of the leaves it turns on. */
export function choiceProblem(
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  choice: CapabilityChoice,
): AdaptiveProblem | undefined {
  return leavesProblem(view, capabilities, choice.leaves)
}

/** A card's effective state, with the reason whenever it is inert. `key` is a template for `t`. */
export type CapabilityStatus = {
  tone: "off" | "active" | "waiting" | "inactive"
  key: string
  params?: Record<string, string | number>
}

/** The capabilities that ride on the engine's legacy hooks, which a V2 session never calls. */
const HOOKED = new Set<CapabilityID>(["suggestions", "loops"])

const ACTIVE: Record<string, string> = {
  observing: "Active · observing, nothing is changed",
  acting: "Active · trimming what the agent sees",
  suggesting: "Active · suggesting skills",
  warning: "Active · watching for repeated steps",
  proposing: "Active · proposing skills for your approval",
}

/**
 * What a card is really doing, derived from the switches, the guards and the runtime: a switch that
 * is on but cannot act says why, instead of letting a bare "on" suggest it acts.
 */
export function capabilityStatus(
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  capability: Capability,
): CapabilityStatus {
  const choice = capabilityChoice(view, capability)
  if (choice === "off") return { tone: "off", key: "Off" }
  const inert = inertStatus(view)
  if (inert) return inert
  const field = writableField(view, capability.leaf)
  const problem = field ? fieldProblem(field, view, capabilities, capability.leaf) : undefined
  if (problem === "no-adaptive-token")
    return { tone: "inactive", key: "Inactive: this server was started without permission to act on sessions." }
  if (problem)
    return { tone: "inactive", key: "Inactive: it needs your permission to share data with the model provider." }
  if (HOOKED.has(capability.id) && view.runtime.runtime === "v2")
    return { tone: "inactive", key: "Inactive: this engine's newer session runtime cannot run it yet." }
  if (capability.id === "learning" && view.effective.learning.frozen === true)
    return {
      tone: "waiting",
      key: "Frozen · no new proposals. Pending ones can still be reviewed, and learned skills stay in use.",
    }
  if (capability.id === "learning") return learningStatus(view)
  return { tone: "active", key: ACTIVE[choice] ?? "Active · in use" }
}

/**
 * Which path Learning proposes with (AH-F01): the predictive model when it may review sessions, else
 * the built-in rules, which run on this machine. On the model path a missing drafting model also
 * falls back to the built-in rules. An older server that does not say is read from the draft alone.
 */
function learningStatus(view: AdaptiveConfigView): CapabilityStatus {
  const classifier = view.learningClassifier
  if (classifier && !classifier.ready)
    return {
      tone: "active",
      key:
        classifier.model === null
          ? "Active · proposing skills with built-in rules: no predictive model is set to review sessions"
          : "Active · proposing skills with built-in rules: the predictive model has no permission to review sessions",
    }
  if (view.learningDraft?.model === null)
    return classifier
      ? { tone: "waiting", key: "Active · proposing skills with built-in rules until there is a model to draft them with" }
      : { tone: "waiting", key: "Active · waiting for a model to draft skills with" }
  if (classifier) return { tone: "active", key: "Active · proposing skills with the predictive model, for your approval" }
  return { tone: "active", key: ACTIVE.proposing! }
}

const LIMIT_TEXT: Record<AdaptiveLearningLimitHit["limit"], string> = {
  "proposals-per-day": "Paused in {project}: {used} proposals in the last 24 hours, the daily limit.",
  "learned-skills":
    "No new skills in {project}: {used} learned skills, the limit. Improving the existing ones continues.",
  "patches-per-week": "No more skill improvements in {project}: {used} in the last 7 days, the weekly limit.",
}

/**
 * What each learning limit a project has reached says (AH-F03), as templates for `t`. The project is
 * named by its folder, and the whole path travels as the `title` for the reader who needs it.
 */
export function learningLimitLines(
  view: AdaptiveConfigView,
): Array<{ key: string; params: Record<string, string | number>; path: string }> {
  if (!view.effective.learning.enabled || view.effective.learning.frozen === true) return []
  return (view.learningLimits?.reached ?? []).map((hit) => ({
    key: LIMIT_TEXT[hit.limit],
    params: { project: hit.projectID.split(/[\\/]/).filter(Boolean).pop() ?? hit.projectID, used: hit.used },
    path: hit.projectID,
  }))
}

/** The reasons that make every capability inert at once: the environment, then the level. */
function inertStatus(view: AdaptiveConfigView): CapabilityStatus | undefined {
  if (view.env.adaptiveDisabled) return { tone: "inactive", key: "Inactive: set to Off by the environment." }
  if (!view.effective.enabled) return { tone: "inactive", key: "Inactive: the level is Off." }
  return undefined
}

/**
 * The predictive models' state, derived from the assignments: not configured while no decision has a
 * model, else which model answers each decision and what each still waits for — its provider's
 * permission or its key — or paused because the value gate (AH-C05) judged it does not pay for itself.
 */
export function predictiveStatus(view: AdaptiveConfigView, voi?: ValueGateSnapshot): CapabilityStatus {
  const rows = modelKinds(view).flatMap((kind) => {
    const id = assignedModel(view, kind)
    return id === undefined ? [] : [{ kind, id, missing: missingForKind(view, kind, id) }]
  })
  if (rows.length === 0) return { tone: "off", key: "Not configured" }
  const inert = inertStatus(view)
  if (inert) return inert
  const assignments = rows
    .map((row) => {
      const words = { kind: t(KIND_LABELS[row.kind] ?? row.kind), model: modelName(view, row.id) }
      if (row.missing.length === 0) return t("{kind}: {model}", words)
      const reason = row.missing.some((item) => item.key !== "the model key") ? "needs permission" : "key missing"
      return t("{kind}: {model} ({reason})", { ...words, reason: t(reason) })
    })
    .join(" · ")
  if (rows.every((row) => row.missing.length > 0)) return { tone: "waiting", key: "{assignments}", params: { assignments } }
  const gates = voi?.enabled ? voi.kinds : []
  const paused = gates.filter((gate) => gate.state === "paused").length
  if (gates.length > 0 && paused === gates.length)
    return { tone: "inactive", key: "Paused: it is not adding enough value" }
  if (paused > 0)
    return {
      tone: "active",
      key: "Active · paused for {paused} of {total} decisions, for low value",
      params: { paused, total: gates.length },
    }
  return { tone: "active", key: "{assignments}", params: { assignments } }
}

/** What the predictive model cost over the value gate's window, in USD, rounded for reading. */
export function predictiveCost(voi?: ValueGateSnapshot): string {
  const usd = (voi?.kinds ?? []).reduce((sum, gate) => sum + gate.costUsd, 0)
  return usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)
}

/** Every decision kind said in plain words, for the selectors, the consent rows and the value gate. */
export const KIND_LABELS: Record<string, string> = {
  completion: "Whether the task is finished",
  skillRelevance: "Which skills fit",
  contextItem: "Which context to keep",
  skillReflection: "Whether a session is worth learning from",
  modelRoute: "Which model to use",
  agentRoute: "Which agent to use",
  toolRisk: "How risky a tool call is",
  failure: "Why a step failed",
}

export const GATE_LABELS: Record<ValueGateState, string> = {
  "warming-up": "Measuring its value",
  asking: "Asked",
  exploring: "Asked now and then: its value does not cover its cost",
  paused: "Paused: it does not help here",
}

/** The leaves a section of its own draws, so Advanced does not draw them twice. */
const CLAIMED = new Set([
  "enabled",
  "context.enabled",
  "context.apply",
  "relevance.enabled",
  "guardrails.enabled",
  "learning.enabled",
  "learning.frozen",
  "jev.enabled",
  "retention.enabled",
  "budget.monthlyTokens",
])

/**
 * Leaves the server lists only so a replay variant can switch them (AH-D03): its own descriptor says
 * the settings panel draws no control for them until the replay promotes them.
 */
const REPLAY_ONLY = new Set(["selection.enabled", "selection.coldGapMs"])

/** The plain names of the switches Advanced knows; any other listed switch shows its path. */
export const ADVANCED_LABELS: Record<string, string> = {
  shadow: "Record decisions in the background",
  "toolTrim.enabled": "Shorten long tool outputs (recoverable)",
  "compaction.anchors": "Keep session anchors when compacting",
}

/**
 * Every other boolean switch the server lists, for Advanced: drawing from `writable` rather than a
 * hardcoded list is what keeps a newly listed switch reachable (P-H8).
 */
export function advancedFields(view: AdaptiveConfigView): AdaptiveWritableField[] {
  return view.writable.filter(
    (field) =>
      field.type === "boolean" && !field.path.includes("*") && !CLAIMED.has(field.path) && !REPLAY_ONLY.has(field.path),
  )
}

/**
 * The budget draft after the server's value moves from `before` to `after`.
 *
 * Any successful write answers the whole view, so the budget value is re-read even when another
 * switch saved: a draft the reader typed but did not save survives, and an untouched draft follows
 * the server.
 */
export function nextBudgetDraft(draft: string, before: string | undefined, after: string): string {
  if (before === undefined || draft === before) return after
  return draft
}

/** Whether a value widens a provider's consent, which the server only writes with `confirm: true`. */
function widens(path: string, value: unknown, view: AdaptiveConfigView): boolean {
  const consent = consentPath(path)
  if (!consent) return false
  const before = consentOf(view, consent.provider)
  if (consent.leaf === "projects" && Array.isArray(value)) {
    const known = new Set(before?.projects ?? [])
    return value.some((project) => typeof project === "string" && !known.has(project))
  }
  if (consent.leaf === "kinds" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).some(
      ([kind, on]) => on === true && before?.kinds[kind] !== true,
    )
  }
  return false
}

/**
 * Whether a write to this leaf must carry `confirm: true`, read from the server's descriptor.
 *
 * `required` asks for the confirmation itself; `widening` asks only when the value actually adds a
 * project or turns a kind on, so narrowing the allowlist is never gated behind a dialog.
 */
export function needsConfirmation(path: string, value: unknown, view: AdaptiveConfigView): boolean {
  const field = writableField(view, path)
  if (!field) return false
  if (field.confirmation === "required") return value === true
  if (field.confirmation === "widening") return widens(path, value, view)
  return false
}

/** A nested patch object for one dotted leaf, the shape `PATCH /harness/adaptive/config` takes. */
export function patchLeaf(path: string, value: unknown): Record<string, unknown> {
  return patchOf({ [path]: value })
}

/**
 * One nested patch for several dotted leaves, so a level or a card state travels as a single write.
 * The server evaluates guards on the config after the whole patch, so the leaves' order never matters.
 */
export function patchOf(leaves: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(leaves)) {
    const segments = path.split(".")
    const parent = segments.slice(0, -1).reduce<Record<string, unknown>>((node, key) => {
      const child = node[key]
      if (isRecord(child)) return child
      const created: Record<string, unknown> = {}
      node[key] = created
      return created
    }, root)
    parent[segments[segments.length - 1]!] = value
  }
  return root
}

/** One `422` code said in the reader's words, plus the leaves the server named as missing. */
export type AdaptiveFeedback = { message: string; missing: string[] }

const FEEDBACK: Record<string, string> = {
  "unsupported-field": "This settings surface does not write that field.",
  "invalid-value": "That value is not valid for this setting.",
  "confirmation-required": "This change needs confirmation.",
  "env-disabled": "Turned off by the environment.",
  "guard:no-adaptive-token": "This server was started without permission to act on sessions.",
  "guard:egress-allowlist-required": "First allow sharing data with the model provider, for a project and a decision.",
  "invalid-config": "The config file is not valid JSON, so it was left alone.",
  "config-unreadable": "The config file could not be read.",
  bad_request: "The server did not understand that request.",
  not_found: "This server does not have that route.",
  invalid_token: "The server refused the request: it needs the loopback token.",
  internal_error: "The server failed while writing the config.",
  "invalid-key": "The key cannot be empty.",
  "vault-unavailable": "This machine cannot store the key: its encrypted store is not available.",
  "invalid-endpoint": "The predictive model's address is not valid, so the key was not saved.",
  "unknown-model": "That model is not available for this decision on this server.",
}

export function feedbackFor(code: string, missing?: string[]): AdaptiveFeedback {
  return { message: FEEDBACK[code] ?? "The change could not be saved.", missing: missing ?? [] }
}

/**
 * Whether the server's last refusal blamed this leaf. The `422` travels `fields`; the panel uses
 * them to highlight the controls it named instead of leaving the reader to guess which one failed.
 */
export function refusedField(error: AdaptiveConfigError | undefined, path: string): boolean {
  return error?.fields?.includes(path) ?? false
}

/** A warning the server travelled beside a successful write, said in the reader's words. */
const WARNINGS: Record<string, string> = {
  "evaluation-gated": "Applying is configured, but promotion waits for the offline evaluation.",
  "runtime-inert": "Configured, but inert on this runtime.",
  "no-model": "There is no model to draft skills with, so the built-in rules propose them instead.",
  "skills-still-load": "Learned skills still load from disk.",
  "learning-draft-egress": "Learning drafts are sent, redacted, to the configured small model's provider.",
  "classifier-no-consent":
    "The predictive model cannot review sessions, so skills are proposed with built-in rules on this machine.",
  "model-no-consent":
    "The model is chosen, but it cannot receive this decision until you allow sharing it with its provider. Built-in rules decide meanwhile.",
}

export function warningKey(warning: string): string {
  return WARNINGS[warning] ?? warning
}

/**
 * What the confirmation dialog says before a write: the consequence — what is sent, to whom, or what
 * is removed — never the field path it writes (AH-E06). Turning learning on is a data-sharing decision
 * of its own — the draft goes to the small model's provider, not to the predictive model — so the
 * dialog says what is sent and to whom.
 */
export function confirmationMessage(path: string, value: unknown, view: AdaptiveConfigView): string {
  const consent = consentPath(path)
  if (consent?.leaf === "enabled" && value === true)
    return t(
      "Consenting to {provider}: redacted, size-limited decision inputs for the listed projects and decisions are sent to {provider}. It covers {provider} only, no other provider. The change is written to the config file.",
      { provider: modelName(view, consent.provider) },
    )
  if (path === "retention.enabled" && value === true)
    return t(
      "Cleaning up removes adaptive history older than its retention window. Learned skills are never removed. The change is written to the config file.",
    )
  if (path === "jev.enabled" && value === true)
    return t(
      "The predictive model receives redacted, size-limited decision inputs for the projects and decisions you allowed. The change is written to the config file.",
    )
  if (consent?.leaf === "projects" && Array.isArray(value)) {
    const known = new Set(consentOf(view, consent.provider)?.projects ?? [])
    return t(
      "{provider} may then receive redacted, size-limited decision inputs from {projects}. The change is written to the config file.",
      { provider: modelName(view, consent.provider), projects: value.filter((project) => !known.has(project)).join(", ") },
    )
  }
  if (consent?.leaf === "kinds" && isRecord(value)) {
    const before = consentOf(view, consent.provider)?.kinds ?? {}
    const added = Object.keys(value).filter((kind) => value[kind] === true && before[kind] !== true)
    return t(
      "{provider} may then receive redacted, size-limited inputs to decide: {kinds}. The change is written to the config file.",
      { provider: modelName(view, consent.provider), kinds: added.map((kind) => t(KIND_LABELS[kind] ?? kind)).join(", ") },
    )
  }
  if (path !== "learning.enabled" || value !== true)
    return t("This changes what the adaptive harness may do or send. The change is written to the config file.")
  const chars = view.effective.learning.maxInputChars
  const model = view.learningDraft?.model
  // With the built-in rules nothing is drafted remotely, but the switch is still the draft's consent
  // for when the predictive model may review sessions, so the dialog says both.
  if (view.learningClassifier?.ready === false && model)
    return t(
      "Learning proposes skills with built-in rules on this machine, so nothing is sent: the predictive model cannot review sessions. If it later may, up to {chars} characters of each qualifying session's objective and evidence, with secrets redacted, are sent through the engine to {model} and its provider to draft the skill. The change is written to the config file.",
      { chars, model },
    )
  if (view.learningClassifier?.ready === false)
    return t(
      "Learning proposes skills with built-in rules on this machine, so nothing is sent: the predictive model cannot review sessions. If it later may, up to {chars} characters of each qualifying session's objective and evidence, with secrets redacted, are sent through the engine to the configured small model's provider to draft the skill. The change is written to the config file.",
      { chars },
    )
  if (model)
    return t(
      "Learning drafts a skill from each qualifying session: up to {chars} characters of its objective and evidence, with secrets redacted, are sent through the engine to {model} and its provider. The change is written to the config file.",
      { chars, model },
    )
  return t(
    "Learning drafts a skill from each qualifying session: up to {chars} characters of its objective and evidence, with secrets redacted, are sent through the engine to the configured small model's provider. No model is configured yet, so until one is the built-in rules propose skills on this machine. The change is written to the config file.",
    { chars },
  )
}

/**
 * What a runtime alert says (AH-D05), as a template for `t` and its holes. The acting plugins ride on
 * hooks an engine may not call (docs/V2-HOOKS.md), so an alert says what that costs. For the engine
 * running now, `hooksFire` is the probe's answer (on OpenCode 2, FlupCode's plugin answering from inside
 * the engine, V2-51), so its version change says whether anything needs checking at all; an older
 * change was superseded and only says what happened.
 */
export function runtimeAlertText(
  alert: AdaptiveRuntimeAlert,
  hooksFire?: boolean,
): { key: string; params: Record<string, string> } {
  if (alert.kind === "runtime-changed")
    return {
      key: "The engine runtime changed from {from} to {to}. Relevance and guardrails rely on legacy hooks; check docs/V2-HOOKS.md.",
      params: { from: alert.from ?? "?", to: alert.to },
    }
  if (alert.kind === "engine-version-changed")
    return {
      key:
        hooksFire === undefined
          ? "The engine changed from version {from} to {to}."
          : hooksFire
            ? "The engine changed from version {from} to {to}. FlupCode's plugins answered from it, so the adaptive features work there."
            : "The engine changed from version {from} to {to}. FlupCode's plugins have not answered from it yet, so the adaptive features stay off until they do (docs/V2-HOOKS.md).",
      params: { from: alert.from ?? "?", to: alert.to },
    }
  return {
    key: "The engine ran turns on the V2 runner ({event}). The adaptive hooks do not fire on those turns.",
    params: { event: alert.to },
  }
}

/** Where a leaf's value comes from, as a key for `t`. */
export function sourceKey(provenance: AdaptiveProvenance): string {
  if (provenance === "env") return "from the environment"
  if (provenance === "block") return "from the config file"
  return "default"
}

type PendingConfirm = { message: string; patch: Record<string, unknown> }

/** Everything the panel needs from the cockpit: the view, what health announced, and the outcome. */
export type AdaptiveSettingsState = {
  view?: AdaptiveConfigView
  loading: boolean
  failure?: Error
  /** What `/harness/health` announced: relevance is only offered when the acting line exists. */
  capabilities: string[]
  saving: boolean
  warnings: string[]
  error?: AdaptiveConfigError
  /** The value gate per kind (AH-C05), read only when the server announced `adaptive-voi`. */
  voi?: ValueGateSnapshot
}

/** A change to the predictive model's key, sent only after the reader confirmed it. */
export type ModelKeyChange = { key: string } | { remove: true }

type AdaptiveSettingsPanelProps = AdaptiveSettingsState & {
  onPatch: (patch: Record<string, unknown>, confirm: boolean) => void
  /** Saves or removes the predictive model's key; offered only when the server announced the route. */
  onModelKey?: (change: ModelKeyChange) => void
  /** Dismisses the runtime alerts (AH-D05); offered only when the server announced the route. */
  onAcknowledgeRuntime: () => void
}

const LEVEL_LABELS: Record<AdaptiveLevel, string> = {
  off: "Off",
  observe: "Observe",
  assist: "Assist",
  custom: "Custom",
}

const LEVEL_HINTS: Record<AdaptiveLevel, string> = {
  off: "Nothing runs. Your choices below are kept for when you turn it back on.",
  observe: "Watches your sessions and notes what it would do, without changing anything.",
  assist: "Suggests skills and warns about loops while you work.",
  custom: "Your own mix of the capabilities below.",
}

/**
 * The adaptive settings (FH-070/FH-074, AH-E01): four capabilities, each at a level.
 *
 * The level selector is the kill switch: Off writes only the master `enabled`, which stops every
 * capability and keeps each one's own value; the copy says plainly that learned skills still load,
 * because there is no seam to stop that. Every card and row is drawn from the server's `writable`
 * allowlist, each card says what it is really doing and why when it is inert, and a guard that cannot
 * be met disables the choice with its reason instead of offering a `422`.
 */
export const AdaptiveSettingsPanel: Component<AdaptiveSettingsPanelProps> = (props) => {
  const [pending, setPending] = createSignal<PendingConfirm>()
  const [budget, setBudget] = createSignal("")
  // The key itself lives only in the password field until the confirmed save reads and clears it: no
  // signal ever holds it, only whether the field has something in it.
  const [keyPending, setKeyPending] = createSignal<"save" | "remove">()
  const [keyDraft, setKeyDraft] = createSignal(false)
  const [keyEditing, setKeyEditing] = createSignal(false)
  let keyInput: HTMLInputElement | undefined

  // The server's budget as last seen, so a write to another switch does not wipe an unsaved draft.
  let serverBudget: string | undefined
  createEffect(() => {
    const view = props.view
    if (!view) return
    const next = String(view.effective.budget.monthlyTokens)
    setBudget((draft) => nextBudgetDraft(draft, serverBudget, next))
    serverBudget = next
  })

  const readOnly = () => !props.view?.canWrite
  // While a write is in flight every control waits: a second click would build its patch from the
  // same stale view the first one did.
  const locked = () => readOnly() || props.saving
  const refused = (path: string) => refusedField(props.error, path)
  const field = (path: string) => (props.view ? writableField(props.view, path) : undefined)
  const problem = (path: string) => {
    const view = props.view
    const entry = field(path)
    return view && entry ? fieldProblem(entry, view, props.capabilities, path) : undefined
  }
  /** Why a switch cannot be turned on right now, in the reader's words: what is missing, else the guard. */
  const blocked = (path: string) => {
    const view = props.view
    const missing = view ? missingFor(view, path) : []
    if (missing.length > 0) return missingText(missing)
    const reason = problem(path)
    return reason ? t(problemKey(reason)) : undefined
  }
  const value = (path: string) => (props.view ? leafOn(props.view, path) : false)
  const provenance = (path: string) => {
    const source = props.view?.source[path]
    return source ? t(sourceKey(source)) : ""
  }
  const level = () => (props.view ? currentLevel(props.view) : "off")
  /**
   * Sends one nested patch, opening the dialog first when any leaf's descriptor asks for a
   * confirmation; the dialog speaks for the first leaf that asked.
   */
  const proposeLeaves = (leaves: Record<string, unknown>) => {
    const view = props.view
    if (!view || locked()) return
    const patch = patchOf(leaves)
    const gated = Object.entries(leaves).find(([path, next]) => needsConfirmation(path, next, view))
    if (gated) {
      setPending({ message: confirmationMessage(gated[0], gated[1], view), patch })
      return
    }
    props.onPatch(patch, false)
  }
  const propose = (path: string, next: unknown) => proposeLeaves({ [path]: next })
  const chooseLevel = (next: AdaptiveLevel) => {
    const view = props.view
    if (!view || next === level()) return
    proposeLeaves(levelLeaves(view, next))
  }

  /** One boolean row, drawn only when the server lists its leaf as writable. */
  const Switch = (row: {
    path: string
    label: string
    params?: Record<string, string | number>
    children?: JSX.Element
  }) => (
    <Show when={field(row.path)}>
      <div class="fc-settings-row" classList={{ "fc-settings-refused": refused(row.path) }}>
        <span class="fc-settings-usage">
          <span>{t(row.label, row.params)}</span>
          {row.children}
          <Show when={blocked(row.path)}>{(reason) => <span class="fc-settings-hint">{reason()}</span>}</Show>
          <Show when={props.view && inactiveByMaster(props.view, row.path)}>
            <span class="fc-settings-hint">{t("Inactive: the master switch is off.")}</span>
          </Show>
        </span>
        <Toggle
          checked={value(row.path)}
          label={t(row.label, row.params)}
          // A blocked switch that is already on can still be turned off: only turning on needs the guard.
          disabled={locked() || (!!blocked(row.path) && !value(row.path))}
          onToggle={() => propose(row.path, !value(row.path))}
        />
      </div>
    </Show>
  )

  /** A card's effective state, worded; the tone is also said by the words, never by colour alone. */
  const Status = (row: { status: CapabilityStatus }) => (
    <p class="fc-adaptive-status" data-tone={row.status.tone}>
      {t(row.status.key, row.status.params)}
    </p>
  )

  /** One capability at its level: the choices the server allows, the state it is really in, and why. */
  const CapabilityCard = (card: { capability: Capability; view: AdaptiveConfigView }) => {
    const choices = () => capabilityChoices(card.view, card.capability)
    const selected = () => capabilityChoice(card.view, card.capability)
    const titleID = `fc-adaptive-card-${card.capability.id}`
    const blocked = () =>
      choices().flatMap((choice) => {
        const reason = choiceProblem(card.view, props.capabilities, choice)
        return reason && choice.id !== selected() ? [{ choice, reason }] : []
      })
    return (
      <section
        class="fc-adaptive-card"
        classList={{
          "fc-settings-refused": choices().some((choice) => Object.keys(choice.leaves).some(refused)),
        }}
        aria-labelledby={titleID}
      >
        <div class="fc-adaptive-card-head">
          <span class="fc-settings-usage">
            <h4 id={titleID} class="fc-adaptive-card-title">
              {t(card.capability.title)}
            </h4>
            <span class="fc-settings-hint">{t(card.capability.description)}</span>
          </span>
          <Segmented
            labelledBy={titleID}
            options={choices().map((choice) => ({
              id: choice.id,
              label: t(choice.label),
              unavailable: !!choiceProblem(card.view, props.capabilities, choice),
            }))}
            value={selected()}
            locked={locked()}
            onSelect={(id) => {
              const choice = choices().find((entry) => entry.id === id)
              if (choice) proposeLeaves(choice.leaves)
            }}
          />
        </div>
        <Status status={capabilityStatus(card.view, props.capabilities, card.capability)} />
        <For each={blocked()}>
          {(entry) => (
            <p class="fc-settings-hint">
              {t("{choice} is not available: {reason}", {
                choice: t(entry.choice.label),
                reason: t(problemKey(entry.reason)),
              })}
            </p>
          )}
        </For>
        <Show when={choices().some((choice) => choice.id === "acting")}>
          <p class="fc-settings-hint">
            {t("* Acting changes what the agent sees, and it has not passed the offline evaluation yet.")}
          </p>
        </Show>
        <Show when={card.capability.id === "learning"}>
          <p class="fc-settings-hint">
            {card.view.learningClassifier?.ready === false
              ? t("Turning it on asks first. With the built-in rules, nothing leaves this machine.")
              : card.view.learningDraft?.model
                ? t("Turning it on asks first: redacted session notes are sent to {model} to draft each skill.", {
                    model: card.view.learningDraft.model,
                  })
                : t("Turning it on asks first: redacted session notes are sent to a model to draft each skill.")}
          </p>
          <For each={learningLimitLines(card.view)}>
            {(line) => (
              <p class="fc-adaptive-status" data-tone="waiting" title={line.path}>
                {t(line.key, line.params)}
              </p>
            )}
          </For>
          <Switch path="learning.frozen" label="Freeze learning">
            <span class="fc-settings-hint">
              {t("Stops new proposals without turning learning off: you can still review pending ones, and learned skills stay in use.")}
            </span>
          </Switch>
        </Show>
      </section>
    )
  }

  /**
   * One remote provider's section: the projects and the decisions it may receive, its switch, and —
   * only for a model that needs one — its key. Each row names the provider by the name the server
   * gives it, and consenting to one never covers another.
   */
  const ProviderConsent = (row: { provider: string; view: AdaptiveConfigView }) => {
    const [project, setProject] = createSignal("")
    const path = (leaf: string) => `egress.providers.${row.provider}.${leaf}`
    const name = () => modelName(row.view, row.provider)
    const projects = () => (props.view ? consentOf(props.view, row.provider)?.projects : undefined) ?? []
    const kinds = () => (props.view ? consentOf(props.view, row.provider)?.kinds : undefined) ?? {}
    return (
      <>
        <Show when={field(path("enabled")) || field(path("projects")) || field(path("kinds"))}>
          <div class="fc-settings-subtitle">{t("Sharing with {provider}", { provider: name() })}</div>
        </Show>
        <Show when={field(path("projects"))}>
          <Show
            when={projects().length > 0}
            fallback={<div class="fc-settings-hint">{t("No projects allowed yet.")}</div>}
          >
            <For each={projects()}>
              {(allowed) => (
                <div class="fc-usage-row" classList={{ "fc-settings-refused": refused(path("projects")) }}>
                  <span class="fc-usage-key" dir="auto" title={allowed}>
                    {allowed}
                  </span>
                  <Show when={!readOnly()}>
                    <button
                      class="fc-button"
                      type="button"
                      disabled={locked()}
                      onClick={() =>
                        propose(
                          path("projects"),
                          projects().filter((entry) => entry !== allowed),
                        )
                      }
                    >
                      {t("Remove")}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={!readOnly()}>
            <div class="fc-field-row" classList={{ "fc-settings-refused": refused(path("projects")) }}>
              <label class="fc-field">
                <span>{t("Project path for {provider}", { provider: name() })}</span>
                <input
                  class="fc-question-custom"
                  dir="ltr"
                  value={project()}
                  onInput={(event) => setProject(event.currentTarget.value)}
                />
              </label>
              <button
                class="fc-button"
                type="button"
                disabled={locked() || !project().trim()}
                onClick={() => {
                  propose(path("projects"), [...projects(), project().trim()])
                  setProject("")
                }}
              >
                {t("Add project")}
              </button>
            </div>
          </Show>
        </Show>
        <Show when={field(path("kinds"))}>
          <For each={modelKinds(row.view)}>
            {(kind) => (
              <div class="fc-settings-row" classList={{ "fc-settings-refused": refused(path("kinds")) }}>
                <span>{t(KIND_LABELS[kind] ?? kind)}</span>
                <Toggle
                  checked={kinds()[kind] === true}
                  label={t("{kind} for {provider}", { kind: t(KIND_LABELS[kind] ?? kind), provider: name() })}
                  disabled={locked()}
                  onToggle={() => propose(path("kinds"), { ...kinds(), [kind]: kinds()[kind] !== true })}
                />
              </div>
            )}
          </For>
        </Show>
        <Switch path={path("enabled")} label="Send data to {provider}" params={{ provider: name() }}>
          <span class="fc-settings-hint">
            {t("Needs confirmation. Covers {provider} only.", { provider: name() })}
          </span>
        </Switch>
        <Show when={row.view.models?.find((model) => model.id === row.provider)?.needsKey}>
          <ModelKeyRow view={row.view} />
        </Show>
      </>
    )
  }

  /**
   * Which model answers one decision: None, or a registered model that can answer it, by its name. A
   * chosen model that still waits for something says exactly what, and where the legacy single switch
   * assigned it, the first choice here saves one choice per decision instead.
   */
  const KindModel = (row: { kind: string; view: AdaptiveConfigView }) => {
    const id = `fc-adaptive-model-${row.kind}`
    const current = () => assignedModel(row.view, row.kind)
    const options = () => {
      const assignable = assignableModels(row.view, row.kind).map((model) => model.id)
      const chosen = current()
      return chosen === undefined || assignable.includes(chosen) ? assignable : [...assignable, chosen]
    }
    const missing = () => {
      const chosen = current()
      return chosen === undefined ? [] : missingForKind(row.view, row.kind, chosen)
    }
    return (
      <div class="fc-settings-row" classList={{ "fc-settings-refused": refused(`models.${row.kind}`) }}>
        <span class="fc-settings-usage">
          <label for={id}>{t(KIND_LABELS[row.kind] ?? row.kind)}</label>
          <Show when={missing().length > 0}>
            <span class="fc-settings-hint">{missingText(missing())}</span>
          </Show>
        </span>
        <select
          id={id}
          class="fc-toolbar-select"
          value={current() ?? ""}
          disabled={locked()}
          onChange={(event) => {
            const next = event.currentTarget.value
            // The select shows the server's value until the answer comes back with the new one.
            event.currentTarget.value = current() ?? ""
            proposeLeaves(assignmentLeaves(row.view, row.kind, next === "" ? null : next))
          }}
        >
          <option value="">{t("None (built-in rules)")}</option>
          <For each={options()}>{(model) => <option value={model}>{modelName(row.view, model)}</option>}</For>
        </select>
      </div>
    )
  }

  /**
   * The predictive model's key, write-only: the environment's is only reported, a saved one offers
   * Change and Remove, and a new one goes through a password field and a confirmation. The value is
   * never shown back, and the field is cleared the moment the confirmed save reads it.
   */
  const ModelKeyRow = (row: { view: AdaptiveConfigView }) => {
    const state = () => modelKeyState(row.view)
    const writable = () => adaptiveSurfaces(props.capabilities).modelKey && !!props.onModelKey && !readOnly()
    const editing = () => writable() && (state() === "none" || (state() === "stored" && keyEditing()))
    return (
      <>
        <div class="fc-settings-subtitle">{t("Model key")}</div>
        <Show when={state() === "env"}>
          <p class="fc-adaptive-status" data-tone="active">
            {t("Key set by the environment.")}
          </p>
          <p class="fc-settings-hint">{t("It can only be changed where FlupCode is started (TYPESAFE_API_KEY).")}</p>
        </Show>
        <Show when={state() === "stored" && !editing()}>
          <div class="fc-settings-row">
            <p class="fc-adaptive-status" data-tone="active">
              {t("Key saved")}
            </p>
            <Show when={writable()}>
              <span class="fc-settings-actions">
                <button class="fc-button" type="button" disabled={locked()} onClick={() => setKeyEditing(true)}>
                  {t("Change")}
                </button>
                <button class="fc-button" type="button" disabled={locked()} onClick={() => setKeyPending("remove")}>
                  {t("Remove")}
                </button>
              </span>
            </Show>
          </div>
        </Show>
        <Show when={state() === "unavailable"}>
          <p class="fc-settings-hint">
            {t(
              "This machine cannot store the key: its encrypted store is not available. Set TYPESAFE_API_KEY where FlupCode is started instead.",
            )}
          </p>
        </Show>
        <Show when={state() === "none" && !writable()}>
          <p class="fc-settings-hint">{t("The model key is missing, so built-in rules decide instead.")}</p>
        </Show>
        <Show when={editing()}>
          <div class="fc-field-row">
            <label class="fc-field">
              <span>{t("Predictive model key")}</span>
              <input
                ref={keyInput}
                class="fc-question-custom"
                type="password"
                dir="ltr"
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setKeyDraft(event.currentTarget.value.trim() !== "")}
              />
            </label>
            <button
              class="fc-button"
              type="button"
              disabled={locked() || !keyDraft()}
              onClick={() => setKeyPending("save")}
            >
              {t("Save key")}
            </button>
            <Show when={state() === "stored"}>
              <button
                class="fc-button"
                type="button"
                onClick={() => {
                  setKeyEditing(false)
                  setKeyDraft(false)
                }}
              >
                {t("Cancel")}
              </button>
            </Show>
          </div>
          <p class="fc-settings-hint">{t("Stored encrypted on this machine. It is never shown again.")}</p>
        </Show>
      </>
    )
  }

  return (
    <section class="fc-settings-section" aria-label={t("Adaptive")}>
      <h3 class="fc-settings-title">{t("Adaptive")}</h3>

      <Show
        when={props.view}
        fallback={
          <p class="fc-usage-note">
            {!adaptiveSurfaces(props.capabilities).config
              ? t("This server does not have the adaptive settings.")
              : props.loading
                ? t("Reading…")
                : props.failure instanceof Error
                  ? failureDetail(props.failure)
                  : t("The harness server did not answer.")}
          </p>
        }
      >
        {(view) => (
          <>
            <Show when={readOnly()}>
              <div class="fc-routines-notice">{t("Read-only: this server cannot change these settings.")}</div>
            </Show>

            {/* The runtime probe's warnings (AH-D05): a V2 engine, or a change since the last look. */}
            <Show when={view().runtime.runtime === "v2"}>
              <div class="fc-routines-notice" role="status">
                {t(
                  "This engine runs a newer session runtime: skill suggestions and loop warnings cannot act there yet.",
                )}
              </div>
            </Show>
            <Show when={(view().runtime.alerts ?? []).length > 0}>
              <div class="fc-routines-notice" role="status">
                <span class="fc-settings-usage">
                  <span>{t("The engine changed since you last looked.")}</span>
                  <details class="fc-adaptive-more">
                    <summary>{t("Details")}</summary>
                    <For each={view().runtime.alerts ?? []}>
                      {(alert) => {
                        // Only the latest version change is the engine running now, the one the probe speaks for.
                        const latest = (view().runtime.alerts ?? [])
                          .filter((entry) => entry.kind === "engine-version-changed")
                          .at(-1)
                        const text = runtimeAlertText(
                          alert,
                          alert === latest
                            ? view().runtime.runtime === "legacy" && !view().runtime.degraded
                            : undefined,
                        )
                        // One per line: as inline text, two alerts ran into each other.
                        return <div class="fc-settings-hint">{t(text.key, text.params)}</div>
                      }}
                    </For>
                  </details>
                </span>
                <Show when={adaptiveSurfaces(props.capabilities).runtimeAlerts}>
                  <button class="fc-button" type="button" disabled={props.saving} onClick={props.onAcknowledgeRuntime}>
                    {t("Dismiss")}
                  </button>
                </Show>
              </div>
            </Show>

            {/* The level is the kill switch (FH-074): Off writes only the master and keeps every child. */}
            <Show when={field("enabled")}>
              <div class="fc-adaptive-level" classList={{ "fc-settings-refused": refused("enabled") }}>
                <div class="fc-adaptive-card-head">
                  <span class="fc-settings-usage">
                    <h4 id="fc-adaptive-level" class="fc-adaptive-card-title">
                      {t("Level")}
                    </h4>
                    <span class="fc-settings-hint">{t(LEVEL_HINTS[level()])}</span>
                  </span>
                  <Segmented
                    labelledBy="fc-adaptive-level"
                    options={ADAPTIVE_LEVELS.map((option) => ({
                      id: option,
                      label: t(LEVEL_LABELS[option]),
                      unavailable:
                        !!levelProblem(view(), props.capabilities, option) ||
                        (option === "custom" && (level() === "observe" || level() === "assist")),
                    }))}
                    value={level()}
                    locked={locked()}
                    onSelect={(id) => {
                      const next = ADAPTIVE_LEVELS.find((option) => option === id)
                      if (next) chooseLevel(next)
                    }}
                  />
                </div>
                <p class="fc-settings-hint">
                  {t("Off stops every capability at once. Nothing is deleted, and skills already learned still load.")}
                </p>
                <Show when={view().env.adaptiveDisabled}>
                  <p class="fc-adaptive-status" data-tone="inactive">
                    {t("Set by the environment: the level stays Off.")}
                  </p>
                </Show>
                <Show when={!view().env.adaptiveDisabled}>
                  <For each={ADAPTIVE_LEVELS}>
                    {(option) => (
                      <Show when={levelProblem(view(), props.capabilities, option)}>
                        {(reason) => (
                          <p class="fc-settings-hint">
                            {t("{choice} is not available: {reason}", {
                              choice: t(LEVEL_LABELS[option]),
                              reason: t(problemKey(reason())),
                            })}
                          </p>
                        )}
                      </Show>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <For each={CAPABILITIES}>
              {(capability) => (
                <Show when={field(capability.leaf)}>
                  <CapabilityCard capability={capability} view={view()} />
                </Show>
              )}
            </For>

            <details class="fc-adaptive-details">
              <summary>
                <span>{t("Predictive model")}</span>
                <span class="fc-settings-hint">
                  {t(predictiveStatus(view(), props.voi).key, predictiveStatus(view(), props.voi).params)}
                </span>
              </summary>
              <p class="fc-settings-hint">
                {t(
                  "A predictive model can double-check some of these decisions. It only receives redacted, size-limited inputs, only for the projects you allow, and only from the providers you allow below.",
                )}
              </p>
              {/* Which model answers each decision (AH-C01), then what each remote provider may receive
                  (AH-C03) with its key where it needs one: every row above says what it still waits for. */}
              <Show when={field("models.completion")}>
                <h4 class="fc-settings-subtitle">{t("Which model answers each decision")}</h4>
                <For each={modelKinds(view())}>{(kind) => <KindModel kind={kind} view={view()} />}</For>
                <Show when={view().effective.jev.enabled}>
                  <p class="fc-settings-hint">
                    {t(
                      "These choices come from the older single switch. Changing one saves a choice per decision and turns that switch off.",
                    )}
                  </p>
                </Show>
              </Show>
              <Show when={consentProviders(view()).length > 0}>
                <h4 class="fc-settings-subtitle">{t("Data shared with the predictive model")}</h4>
              </Show>
              <For each={consentProviders(view())}>
                {(provider) => <ProviderConsent provider={provider} view={view()} />}
              </For>
              {/* An older server neither names its models nor assigns them per decision: its key row and
                  its single switch stay as they were. */}
              <Show when={!view().models}>
                <ModelKeyRow view={view()} />
              </Show>
              <Show when={!field("models.completion")}>
                <Switch path="jev.enabled" label="Use the predictive model">
                  <span class="fc-settings-hint">{t("Needs confirmation.")}</span>
                </Switch>
              </Show>
              <Show when={props.voi?.enabled && props.voi.kinds.length > 0}>
                <div class="fc-settings-subtitle">{t("Is it worth asking?")}</div>
                <For each={props.voi?.kinds ?? []}>
                  {(gate) => (
                    <div class="fc-usage-row">
                      <span>{t(KIND_LABELS[gate.kind] ?? gate.kind)}</span>
                      <span class="fc-settings-hint">{t(GATE_LABELS[gate.state])}</span>
                    </div>
                  )}
                </For>
              </Show>
            </details>

            <details class="fc-adaptive-details">
              <summary>
                <span>{t("Data & budget")}</span>
              </summary>
              <Switch path="retention.enabled" label="Clean up old history">
                <span class="fc-settings-hint">
                  {view().effective.retention.decisionsDays
                    ? t("Removes decision history older than {days} days. Needs confirmation.", {
                        days: view().effective.retention.decisionsDays!,
                      })
                    : t("Needs confirmation.")}
                </span>
              </Switch>
              <Show when={field("budget.monthlyTokens")}>
                <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("budget.monthlyTokens") }}>
                  <span class="fc-settings-usage">
                    <label for="fc-adaptive-budget">{t("Monthly budget (tokens)")}</label>
                    <span class="fc-settings-hint">
                      {t("Spent {spent} of {cap} this month.", {
                        spent: view().usage.tokensSpent,
                        cap: view().usage.monthlyTokens,
                      })}
                    </span>
                  </span>
                  <span class="fc-settings-actions">
                    <input
                      id="fc-adaptive-budget"
                      class="fc-question-custom"
                      dir="ltr"
                      inputmode="numeric"
                      value={budget()}
                      onInput={(event) => setBudget(event.currentTarget.value)}
                    />
                    <button
                      class="fc-button"
                      type="button"
                      disabled={locked() || !(Number(budget()) > 0)}
                      onClick={() => propose("budget.monthlyTokens", Number(budget()))}
                    >
                      {t("Save")}
                    </button>
                  </span>
                </div>
              </Show>
              <Show when={props.voi?.enabled && props.voi.kinds.length > 0}>
                <p class="fc-settings-hint">
                  {t("Predictive model cost over its recent decisions: ${usd} (USD).", {
                    usd: predictiveCost(props.voi),
                  })}
                </p>
              </Show>
            </details>

            <details class="fc-adaptive-details">
              <summary>
                <span>{t("Advanced")}</span>
              </summary>
              <Switch path="enabled" label="Master switch">
                <span class="fc-settings-hint">
                  {t("Effective value")}: {value("enabled") ? t("On") : t("Off")} · {provenance("enabled")}
                </span>
                <Show when={view().env.adaptiveDisabled}>
                  <span class="fc-settings-hint">{t("Set by the environment (FLUPCODE_ADAPTIVE_DISABLED=1).")}</span>
                </Show>
              </Switch>
              <For each={advancedFields(view())}>
                {(entry) => <Switch path={entry.path} label={ADVANCED_LABELS[entry.path] ?? entry.path} />}
              </For>
              <div class="fc-settings-subtitle">{t("Where each value comes from")}</div>
              <Show
                when={Object.entries(view().source).some(([, source]) => source !== "default")}
                fallback={<p class="fc-settings-hint">{t("Every setting is at its default.")}</p>}
              >
                <For each={Object.entries(view().source).filter(([, source]) => source !== "default")}>
                  {([path, source]) => (
                    <div class="fc-usage-row">
                      <bdi class="fc-usage-key" dir="ltr">
                        {path}
                      </bdi>
                      <span class="fc-settings-hint">{t(sourceKey(source))}</span>
                    </div>
                  )}
                </For>
              </Show>
              <div class="fc-settings-hint">
                {t("Config file")}: <bdi dir="ltr">{view().writer.path}</bdi>{" "}
                {view().writer.exists ? "" : t("(not created yet)")}
              </div>
            </details>

            {/* A write answers later, so what it says is announced: the region is always mounted and
                only its text changes, which is what every screen reader reads out. */}
            <div role="status" aria-live="polite">
              <Show when={props.saving}>
                <span class="fc-sr-only">{t("Saving…")}</span>
              </Show>
              <For each={props.warnings}>
                {(warning) => <div class="fc-settings-hint">{t(warningKey(warning))}</div>}
              </For>
            </div>
            <Show when={props.error}>
              {(failure) => {
                const feedback = () => feedbackFor(failure().code, failure().missing)
                return (
                  <>
                    <p class="fc-run-error" role="alert">
                      {t(feedback().message)}
                    </p>
                    <Show when={(failure().fields?.length ?? 0) > 0 || feedback().missing.length > 0}>
                      <details class="fc-adaptive-more">
                        <summary>{t("Details")}</summary>
                        <Show when={(failure().fields?.length ?? 0) > 0}>
                          <p class="fc-settings-hint">
                            {t("Refused fields: {fields}", { fields: (failure().fields ?? []).join(", ") })}
                          </p>
                        </Show>
                        <Show when={feedback().missing.length > 0}>
                          <p class="fc-settings-hint">
                            {t("Missing: {fields}", { fields: feedback().missing.join(", ") })}
                          </p>
                        </Show>
                      </details>
                    </Show>
                  </>
                )
              }}
            </Show>
          </>
        )}
      </Show>

      <ConfirmDialog
        open={!!pending()}
        title={t("Confirm change")}
        message={pending()?.message ?? ""}
        confirmLabel={t("Write it")}
        onConfirm={() => {
          const next = pending()
          setPending(undefined)
          if (next) props.onPatch(next.patch, true)
        }}
        onClose={() => setPending(undefined)}
      />
      <ConfirmDialog
        open={!!keyPending()}
        title={keyPending() === "remove" ? t("Remove the key?") : t("Save the key?")}
        message={
          keyPending() === "remove"
            ? t(
                "The saved key is deleted from this machine. Until another key is set, built-in rules decide instead of the predictive model.",
              )
            : t(
                "The key is stored encrypted on this machine and used only for calls to the predictive model's provider. It is never shown again.",
              )
        }
        confirmLabel={keyPending() === "remove" ? t("Remove") : t("Save key")}
        onConfirm={() => {
          const action = keyPending()
          setKeyPending(undefined)
          if (action === "remove") return props.onModelKey?.({ remove: true })
          const key = keyInput?.value.trim() ?? ""
          if (keyInput) keyInput.value = ""
          setKeyDraft(false)
          setKeyEditing(false)
          if (key) props.onModelKey?.({ key })
        }}
        onClose={() => setKeyPending(undefined)}
      />
    </section>
  )
}
