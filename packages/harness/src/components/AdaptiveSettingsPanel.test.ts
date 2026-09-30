import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  advancedFields,
  capabilityChoice,
  capabilityChoices,
  capabilityStatus,
  choiceProblem,
  confirmationMessage,
  currentLevel,
  leafOn,
  levelLeaves,
  levelProblem,
  patchOf,
  predictiveCost,
  predictiveStatus,
  feedbackFor,
  fieldProblem,
  inactiveByMaster,
  learningLimitLines,
  needsConfirmation,
  nextBudgetDraft,
  patchLeaf,
  problemKey,
  refusedField,
  runtimeAlertText,
  sourceKey,
  warningKey,
  writableField,
} from "./AdaptiveSettingsPanel"
import { AdaptiveConfigError } from "../client"
import { setLocale, t } from "../i18n"
import type { AdaptiveConfigView, AdaptiveWritableField, ValueGateSnapshot, ValueGateStatus } from "../types"

const WRITABLE: AdaptiveWritableField[] = [
  { path: "enabled", type: "boolean", confirmation: "none", guard: "env-disabled" },
  { path: "shadow", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.enabled", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.apply", type: "boolean", confirmation: "none", guard: "none", warning: "evaluation-gated" },
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
  { path: "egress.providers.*.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.providers.*.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.providers.*.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
]

const view = (over: Partial<AdaptiveConfigView["effective"]> = {}, envDisabled = false): AdaptiveConfigView => ({
  effective: {
    enabled: true,
    shadow: false,
    context: { enabled: true, apply: false },
    learning: { enabled: false, maxInputChars: 8000 },
    relevance: { enabled: false },
    guardrails: { enabled: false },
    jev: { enabled: false },
    egress: { providers: { jev: { enabled: false, projects: [], kinds: {} } } },
    retention: { enabled: false },
    budget: { monthlyTokens: 100000, hotReserveFraction: 0.2 },
    ...over,
  },
  source: {},
  env: { adaptiveDisabled: envDisabled, typesafeKeyPresent: false },
  runtime: { runtime: "legacy", degraded: false, checkedAt: 0 },
  capabilities: {
    runtime: "legacy",
    degraded: false,
    canUseLegacyHooks: true,
    canInjectSystemPrompt: false,
    canObserveToolCalls: false,
    canObserveCompaction: false,
    canTransformMessages: false,
    canUseSdkPath: true,
    checkedAt: 0,
  },
  canWrite: true,
  writer: { path: "/c/opencode.jsonc", exists: true },
  usage: { month: "2026-09", tokensSpent: 0, calls: 0, monthlyTokens: 100000, hotReserveFraction: 0.2 },
  writable: WRITABLE,
})

/** A view whose providers carry the given consents, every other field at its default. */
const consenting = (providers: Record<string, Partial<{ enabled: boolean; projects: string[]; kinds: Record<string, boolean> }>>) =>
  view({
    egress: {
      providers: Object.fromEntries(
        Object.entries({ jev: {}, ...providers }).map(([id, consent]) => [
          id,
          { enabled: false, projects: [], kinds: {}, ...consent },
        ]),
      ),
    },
  })

describe("the patch a switch writes", () => {
  test("nests a dotted leaf", () => {
    expect(patchLeaf("context.apply", true)).toEqual({ context: { apply: true } })
    expect(patchLeaf("egress.kinds", { completion: true })).toEqual({ egress: { kinds: { completion: true } } })
  })

  test("a top-level leaf is a plain object", () => {
    expect(patchLeaf("enabled", false)).toEqual({ enabled: false })
  })

  test("a number stays a number", () => {
    expect(patchLeaf("budget.monthlyTokens", 5000)).toEqual({ budget: { monthlyTokens: 5000 } })
  })
})

describe("which fields are offered", () => {
  test("the master switch is off and disabled when the environment forbids it", () => {
    expect(fieldProblem(writableField(view({}, true), "enabled")!, view({}, true), [])).toBe("env-disabled")
    expect(problemKey("env-disabled")).toBe("Turned off by the environment.")
  })

  test("relevance is not offered without the acting token capability", () => {
    const field = writableField(view(), "relevance.enabled")!
    expect(fieldProblem(field, view(), ["adaptive-config"])).toBe("no-adaptive-token")
    expect(fieldProblem(field, view(), ["adaptive-relevance"])).toBeUndefined()
  })

  test("learning needs its classifier's consent for a project and skillReflection", () => {
    const field = writableField(view(), "learning.enabled")!
    expect(fieldProblem(field, view(), [])).toBe("egress-allowlist")
    expect(fieldProblem(field, consenting({ jev: { projects: ["/p"] } }), [])).toBe("egress-allowlist")
    expect(
      fieldProblem(field, consenting({ jev: { projects: ["/p"], kinds: { skillReflection: true } } }), []),
    ).toBeUndefined()
    // Another provider's consent is not the classifier's.
    const small = consenting({ "small-llm": { projects: ["/p"], kinds: { skillReflection: true } } })
    expect(fieldProblem(field, small, [])).toBe("egress-allowlist")
    const assigned = { ...small, effective: { ...small.effective, models: { skillReflection: "small-llm" } } }
    expect(fieldProblem(field, assigned, [])).toBeUndefined()
  })

  test("jev needs its own consent on, with any project and any kind", () => {
    const field = writableField(view(), "jev.enabled")!
    expect(fieldProblem(field, view(), [])).toBe("egress-allowlist")
    expect(fieldProblem(field, consenting({ jev: { projects: ["/p"], kinds: { completion: true } } }), [])).toBe(
      "egress-allowlist",
    )
    expect(
      fieldProblem(field, consenting({ jev: { enabled: true, projects: ["/p"], kinds: { completion: true } } }), []),
    ).toBeUndefined()
  })

  test("a provider's consent is found through the descriptor and needs that provider's project and kind", () => {
    const field = writableField(view(), "egress.providers.small-llm.enabled")!
    expect(field.path).toBe("egress.providers.*.enabled")
    const path = "egress.providers.small-llm.enabled"
    const jevOnly = consenting({ jev: { enabled: true, projects: ["/p"], kinds: { completion: true } } })
    expect(fieldProblem(field, jevOnly, [], path)).toBe("egress-allowlist")
    const ready = consenting({ "small-llm": { projects: ["/p"], kinds: { completion: true } } })
    expect(fieldProblem(field, ready, [], path)).toBeUndefined()
    expect(problemKey("egress-allowlist")).toBe(
      "First allow sharing data with the model provider, for a project and a decision.",
    )
  })

  test("a field the server does not list is never found", () => {
    expect(writableField(view(), "runtime.timeoutMs")).toBeUndefined()
  })

  test("loop warnings are offered like relevance: only with the acting token", () => {
    const field = writableField(view(), "guardrails.enabled")!
    expect(field.guard).toBe("adaptive-token")
    expect(fieldProblem(field, view(), ["adaptive-config"])).toBe("no-adaptive-token")
    expect(fieldProblem(field, view(), ["adaptive-relevance"])).toBeUndefined()
    expect(fieldProblem(field, view(), ["adaptive-guardrails"])).toBeUndefined()
    expect(problemKey("no-adaptive-token")).toBe("This server was started without permission to act on sessions.")
  })

  test("a row is drawn only from the server's list, so an older server hides loop warnings", () => {
    const older = { ...view(), writable: WRITABLE.filter((field) => field.path !== "guardrails.enabled") }
    expect(writableField(older, "guardrails.enabled")).toBeUndefined()
    expect(writableField(older, "relevance.enabled")).toBeDefined()
    expect(writableField({ ...view(), writable: [] }, "enabled")).toBeUndefined()
  })

  test("a field whose guard is met is offered", () => {
    expect(fieldProblem(writableField(view(), "context.apply")!, view(), [])).toBeUndefined()
    expect(fieldProblem(writableField(view(), "egress.providers.jev.projects")!, view(), [])).toBeUndefined()
    expect(fieldProblem(writableField(view(), "shadow")!, view(), [])).toBeUndefined()
  })
})

describe("which writes need confirming", () => {
  test("retention and jev only when they are being turned on", () => {
    expect(needsConfirmation("retention.enabled", true, view())).toBe(true)
    expect(needsConfirmation("retention.enabled", false, view())).toBe(false)
    expect(needsConfirmation("jev.enabled", true, view())).toBe(true)
  })

  test("a provider's consent only when it widens that provider's", () => {
    const before = consenting({ jev: { projects: ["/p"], kinds: { completion: true } } })
    expect(needsConfirmation("egress.providers.jev.projects", ["/p", "/q"], before)).toBe(true)
    expect(needsConfirmation("egress.providers.jev.projects", ["/p"], before)).toBe(false)
    expect(needsConfirmation("egress.providers.jev.projects", [], before)).toBe(false)
    expect(needsConfirmation("egress.providers.jev.kinds", { completion: true, skillRelevance: true }, before)).toBe(true)
    expect(needsConfirmation("egress.providers.jev.kinds", { completion: false }, before)).toBe(false)
    // Jev's projects are not small-llm's: the same list widens a provider that has none.
    expect(needsConfirmation("egress.providers.small-llm.projects", ["/p"], before)).toBe(true)
    expect(needsConfirmation("egress.providers.small-llm.kinds", { completion: true }, before)).toBe(true)
  })

  test("turning a provider's consent on asks, and the dialog names that provider only", () => {
    expect(needsConfirmation("egress.providers.small-llm.enabled", true, view())).toBe(true)
    expect(needsConfirmation("egress.providers.small-llm.enabled", false, view())).toBe(false)
    const message = confirmationMessage("egress.providers.small-llm.enabled", true, view())
    expect(message).toContain("sent to small-llm")
    expect(message).toContain("covers small-llm only")
    expect(message).not.toContain("jev")
  })

  test("learning asks when it is being turned on, since its draft leaves the machine", () => {
    expect(needsConfirmation("learning.enabled", true, view())).toBe(true)
    expect(needsConfirmation("learning.enabled", false, view())).toBe(false)
  })

  test("the learning dialog says what is sent and to which model", () => {
    const withModel = { ...view(), learningDraft: { model: "openai/gpt-4o-mini" } }
    const message = confirmationMessage("learning.enabled", true, withModel)
    expect(message).toContain("8000 characters")
    expect(message).toContain("objective and evidence")
    expect(message).toContain("openai/gpt-4o-mini")
    const withoutModel = confirmationMessage("learning.enabled", true, { ...view(), learningDraft: { model: null } })
    expect(withoutModel).toContain("small model's provider")
    expect(withoutModel).toContain("nothing is sent until one is")
    expect(confirmationMessage("retention.enabled", true, view())).toContain("Learned skills are never removed.")
    expect(confirmationMessage("jev.enabled", true, view())).toContain("redacted, size-limited decision inputs")
    // A field without its own words still says what a write means, never a blank dialog or its path.
    expect(confirmationMessage("something.else", true, view())).toBe(
      "This changes what the adaptive harness may do or send. The change is written to the config file.",
    )
  })

  test("widening a provider's consent says who receives what, never the field it writes (AH-E06)", () => {
    const before = consenting({ jev: { projects: ["/p"], kinds: { completion: true } } })
    const projects = confirmationMessage("egress.providers.jev.projects", ["/p", "/q"], before)
    expect(projects).toBe(
      "jev may then receive redacted, size-limited decision inputs from /q. The change is written to the config file.",
    )
    const kinds = confirmationMessage("egress.providers.jev.kinds", { completion: true, skillRelevance: true }, before)
    expect(kinds).toContain("jev may then receive redacted, size-limited inputs to decide: Which skills fit.")
    for (const message of [projects, kinds]) expect(message).not.toMatch(/egress|providers\.|skillRelevance/)
    setLocale("es")
    expect(confirmationMessage("egress.providers.jev.kinds", { skillRelevance: true }, before)).toContain(
      "para decidir: Qué skills encajan.",
    )
    setLocale("en")
  })

  test("a switch without confirmation never asks", () => {
    expect(needsConfirmation("shadow", true, view())).toBe(false)
  })

  test("a plain switch, the budget, or a field the server does not list never asks", () => {
    expect(needsConfirmation("context.apply", true, view())).toBe(false)
    expect(needsConfirmation("budget.monthlyTokens", 5000, view())).toBe(false)
    expect(needsConfirmation("runtime.timeoutMs", 1, view())).toBe(false)
  })
})

describe("the server's answer said in the reader's words", () => {
  test("a known code becomes its message, with what is missing", () => {
    expect(feedbackFor("guard:egress-allowlist-required", ["egress.projects"]).missing).toEqual(["egress.projects"])
    expect(feedbackFor("guard:no-adaptive-token").message).toBe(
      "This server was started without permission to act on sessions.",
    )
  })

  test("an unknown code does not invent a field", () => {
    expect(feedbackFor("something-new").message).toBe("The change could not be saved.")
    expect(feedbackFor("something-new").missing).toEqual([])
  })

  test("every code the server can send has a message of its own, not the generic fallback", () => {
    const codes = [
      "unsupported-field",
      "invalid-value",
      "confirmation-required",
      "env-disabled",
      "guard:no-adaptive-token",
      "guard:egress-allowlist-required",
      "invalid-config",
      "config-unreadable",
      "bad_request",
      "not_found",
      "invalid_token",
      "internal_error",
    ]
    for (const code of codes) expect(feedbackFor(code).message).not.toBe("The change could not be saved.")
  })

  test("the warnings the server sends have their own words", () => {
    expect(warningKey("skills-still-load")).toBe("Learned skills still load from disk.")
    expect(warningKey("learning-draft-egress")).toBe(
      "Learning drafts are sent, redacted, to the configured small model's provider.",
    )
    expect(warningKey("evaluation-gated")).toBe("Applying is configured, but promotion waits for the offline evaluation.")
  })

  test("provenance is said where it comes from", () => {
    expect(sourceKey("env")).toBe("from the environment")
    expect(sourceKey("block")).toBe("from the config file")
    expect(sourceKey("default")).toBe("default")
  })
})

describe("the fields a refusal blamed", () => {
  test("marks only the leaves the server named", () => {
    const error = new AdaptiveConfigError("needs confirmation", "confirmation-required", ["retention.enabled"])
    expect(refusedField(error, "retention.enabled")).toBe(true)
    expect(refusedField(error, "shadow")).toBe(false)
  })

  test("without a refusal, or without fields, nothing is blamed", () => {
    expect(refusedField(undefined, "shadow")).toBe(false)
    expect(refusedField(new AdaptiveConfigError("no target", "env-disabled"), "shadow")).toBe(false)
  })
})

describe("the switches the master stops", () => {
  test("with the master off, the gated switches say they are inactive", () => {
    const off = view({ enabled: false })
    for (const path of ["shadow", "context.apply", "relevance.enabled", "guardrails.enabled", "jev.enabled"])
      expect(inactiveByMaster(off, path)).toBe(true)
  })

  test("retention, the master itself and the allowlist are not gated", () => {
    const off = view({ enabled: false })
    expect(inactiveByMaster(off, "retention.enabled")).toBe(false)
    expect(inactiveByMaster(off, "enabled")).toBe(false)
    expect(inactiveByMaster(off, "egress.providers.jev.enabled")).toBe(false)
  })

  test("with the master on, nothing is inactive", () => {
    expect(inactiveByMaster(view(), "guardrails.enabled")).toBe(false)
  })
})

describe("the budget draft", () => {
  test("the first view fills it", () => {
    expect(nextBudgetDraft("", undefined, "100000")).toBe("100000")
  })

  test("an unsaved draft survives a write to another switch", () => {
    expect(nextBudgetDraft("5000", "100000", "100000")).toBe("5000")
  })

  test("an untouched draft follows the server when its value changes", () => {
    expect(nextBudgetDraft("100000", "100000", "200000")).toBe("200000")
  })

  test("a draft that was saved matches the server's new value", () => {
    expect(nextBudgetDraft("5000", "100000", "5000")).toBe("5000")
  })
})

describe("the runtime alert (AH-D05)", () => {
  test("a runtime change names both runtimes and where the hook map lives", () => {
    const text = runtimeAlertText({ kind: "runtime-changed", from: "legacy", to: "v2", at: 1 })
    expect(t(text.key, text.params)).toBe(
      "The engine runtime changed from legacy to v2. Relevance and guardrails rely on legacy hooks; check docs/V2-HOOKS.md.",
    )
  })

  test("a version change names both versions", () => {
    const text = runtimeAlertText({ kind: "engine-version-changed", from: "1.2.3", to: "1.3.0", at: 1 })
    expect(t(text.key, text.params)).toContain("from version 1.2.3 to 1.3.0")
  })

  test("V2 turns name the event that proved them", () => {
    const text = runtimeAlertText({ kind: "v2-turns-observed", to: "session.next.prompted", at: 1 })
    expect(t(text.key, text.params)).toContain("(session.next.prompted)")
  })

  test("every alert is translated in Spanish", () => {
    setLocale("es")
    try {
      const alerts = [
        { kind: "runtime-changed" as const, from: "legacy", to: "v2", at: 1 },
        { kind: "engine-version-changed" as const, from: "1", to: "2", at: 1 },
        { kind: "v2-turns-observed" as const, to: "session.next.prompted", at: 1 },
      ]
      for (const alert of alerts) {
        const text = runtimeAlertText(alert)
        expect(t(text.key, text.params)).not.toBe(text.key)
      }
    } finally {
      setLocale("en")
    }
  })
})

// ── AH-E01: levels, capability cards and their derived state ──────────────────────────────────

const ACTING = ["adaptive-config", "adaptive-relevance", "adaptive-guardrails"]
const card = (id: string) => CAPABILITIES.find((capability) => capability.id === id)!
const observing = () => view({ shadow: true })
const assisting = () => view({ shadow: true, relevance: { enabled: true }, guardrails: { enabled: true } })
const gate = (kind: string, state: ValueGateStatus["state"], costUsd = 0): ValueGateStatus => ({
  kind,
  modelID: "jev",
  state,
  samples: 10,
  disagreements: 1,
  disagreementRate: 0.1,
  uplift: 0,
  valueUsd: 0,
  costUsd,
  latencySamples: 0,
})
const snapshot = (kinds: ValueGateStatus[]): ValueGateSnapshot => ({
  enabled: true,
  window: 100,
  minSamples: 10,
  epsilon: 0.01,
  explorationRate: 0.1,
  kinds,
})

describe("one nested patch for several leaves", () => {
  test("siblings share their parent, and the order of leaves does not matter", () => {
    expect(patchOf({ enabled: true, "context.enabled": true, "context.apply": false })).toEqual({
      enabled: true,
      context: { enabled: true, apply: false },
    })
    expect(patchOf({ "context.apply": false, enabled: true, "context.enabled": true })).toEqual(
      patchOf({ enabled: true, "context.enabled": true, "context.apply": false }),
    )
  })
})

describe("the level the switches are at", () => {
  test("the master off is always Off, whatever the children say", () => {
    expect(currentLevel(view({ enabled: false, relevance: { enabled: true } }))).toBe("off")
  })

  test("a preset is read back when every listed leaf matches it", () => {
    expect(currentLevel(observing())).toBe("observe")
    expect(currentLevel(assisting())).toBe("assist")
  })

  test("anything else is Custom", () => {
    expect(currentLevel(view({ shadow: true, relevance: { enabled: true } }))).toBe("custom")
    expect(currentLevel(view({ shadow: true, context: { enabled: true, apply: true } }))).toBe("custom")
  })

  test("learning, the predictive model and retention are the reader's own opt-in, outside every level", () => {
    expect(currentLevel(view({ shadow: true, learning: { enabled: true, maxInputChars: 1 } }))).toBe("observe")
    for (const level of ["off", "observe", "assist", "custom"] as const) {
      const leaves = Object.keys(levelLeaves(view(), level))
      expect(leaves).not.toContain("learning.enabled")
      expect(leaves).not.toContain("jev.enabled")
      expect(leaves).not.toContain("retention.enabled")
    }
  })

  test("each level writes exactly its mapping, as one patch that never needs a confirmation", () => {
    expect(levelLeaves(view(), "off")).toEqual({ enabled: false })
    expect(levelLeaves(view(), "custom")).toEqual({ enabled: true })
    expect(levelLeaves(view(), "observe")).toEqual({
      enabled: true,
      shadow: true,
      "context.enabled": true,
      "context.apply": false,
      "relevance.enabled": false,
      "guardrails.enabled": false,
    })
    expect(levelLeaves(view(), "assist")).toEqual({
      enabled: true,
      shadow: true,
      "context.enabled": true,
      "context.apply": false,
      "relevance.enabled": true,
      "guardrails.enabled": true,
    })
    for (const level of ["off", "observe", "assist", "custom"] as const)
      for (const [path, value] of Object.entries(levelLeaves(view(), level)))
        expect(needsConfirmation(path, value, view())).toBe(false)
  })

  test("a leaf the server does not list is neither written nor compared", () => {
    const older = {
      ...view({ shadow: true }),
      writable: WRITABLE.filter((field) => field.path !== "guardrails.enabled"),
    }
    expect(levelLeaves(older, "assist")).not.toHaveProperty("guardrails.enabled")
    expect(currentLevel({ ...older, effective: { ...older.effective, relevance: { enabled: true } } })).toBe("assist")
  })

  test("Assist is not offered without the acting token; Off always is", () => {
    expect(levelProblem(view(), ["adaptive-config"], "assist")).toBe("no-adaptive-token")
    expect(levelProblem(view(), ACTING, "assist")).toBeUndefined()
    expect(levelProblem(view(), ["adaptive-config"], "observe")).toBeUndefined()
    expect(levelProblem(view(), ["adaptive-config"], "off")).toBeUndefined()
  })

  test("with the environment's kill switch only Off is offered", () => {
    const forced = view({ enabled: false }, true)
    expect(levelProblem(forced, ACTING, "observe")).toBe("env-disabled")
    expect(levelProblem(forced, ACTING, "custom")).toBe("env-disabled")
    expect(levelProblem(forced, ACTING, "off")).toBeUndefined()
  })
})

describe("the capability cards", () => {
  test("a card's choices come from the server's list", () => {
    expect(capabilityChoices(view(), card("context")).map((choice) => choice.id)).toEqual([
      "off",
      "observing",
      "acting",
    ])
    const noApply = { ...view(), writable: WRITABLE.filter((field) => field.path !== "context.apply") }
    const choices = capabilityChoices(noApply, card("context"))
    expect(choices.map((choice) => choice.id)).toEqual(["off", "observing"])
    // A leaf the choice only turns off is left out of the patch instead of being refused.
    expect(choices[0]!.leaves).toEqual({ "context.enabled": false })
  })

  test("the choice is read back from the switches", () => {
    expect(capabilityChoice(view(), card("context"))).toBe("observing")
    expect(capabilityChoice(view({ context: { enabled: true, apply: true } }), card("context"))).toBe("acting")
    // A plan that would apply while planning is off is still off.
    expect(capabilityChoice(view({ context: { enabled: false, apply: true } }), card("context"))).toBe("off")
    expect(capabilityChoice(view({ guardrails: { enabled: true } }), card("loops"))).toBe("warning")
    expect(capabilityChoice(view(), card("suggestions"))).toBe("off")
  })

  test("a choice whose guard fails says why", () => {
    const suggesting = capabilityChoices(view(), card("suggestions"))[1]!
    expect(choiceProblem(view(), ["adaptive-config"], suggesting)).toBe("no-adaptive-token")
    expect(choiceProblem(view(), ACTING, suggesting)).toBeUndefined()
    const proposing = capabilityChoices(view(), card("learning"))[1]!
    expect(choiceProblem(view(), ACTING, proposing)).toBe("egress-allowlist")
    // Turning something off is never guarded.
    expect(choiceProblem(view(), [], capabilityChoices(view(), card("suggestions"))[0]!)).toBeUndefined()
  })

  test("Advanced draws every other listed switch, and never a replay-only one", () => {
    const writable: AdaptiveWritableField[] = [
      ...WRITABLE,
      { path: "toolTrim.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
      { path: "compaction.anchors", type: "boolean", confirmation: "none", guard: "none" },
      { path: "selection.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
      { path: "selection.coldGapMs", type: "number", confirmation: "none", guard: "none" },
    ]
    expect(advancedFields({ ...view(), writable }).map((field) => field.path)).toEqual([
      "shadow",
      "toolTrim.enabled",
      "compaction.anchors",
    ])
  })
})

describe("a card's effective state", () => {
  const status = (current: AdaptiveConfigView, id: string, capabilities = ACTING) =>
    capabilityStatus(current, capabilities, card(id))

  test("off is off", () => {
    expect(status(view(), "suggestions")).toEqual({ tone: "off", key: "Off" })
  })

  test("on but inert always says why", () => {
    const on = view({ relevance: { enabled: true } })
    expect(status({ ...on, effective: { ...on.effective, enabled: false } }, "suggestions").key).toBe(
      "Inactive: the level is Off.",
    )
    expect(status(view({ relevance: { enabled: true }, enabled: false }, true), "suggestions").key).toBe(
      "Inactive: set to Off by the environment.",
    )
    expect(status(on, "suggestions", ["adaptive-config"]).key).toBe(
      "Inactive: this server was started without permission to act on sessions.",
    )
    expect(status({ ...on, runtime: { ...on.runtime, runtime: "v2" } }, "suggestions").key).toBe(
      "Inactive: this engine's newer session runtime cannot run it yet.",
    )
    const learning = view({ learning: { enabled: true, maxInputChars: 1 } })
    expect(status(learning, "learning")).toEqual({
      tone: "inactive",
      key: "Inactive: it needs your permission to share data with the model provider.",
    })
  })

  test("the runtime only makes the hook-based capabilities inert", () => {
    const v2 = view({ guardrails: { enabled: true } })
    const onV2 = { ...v2, runtime: { ...v2.runtime, runtime: "v2" as const } }
    expect(status(onV2, "loops").tone).toBe("inactive")
    expect(status(onV2, "context").tone).toBe("active")
  })

  test("learning without a model is active but waiting", () => {
    const ready = consenting({ jev: { projects: ["/p"], kinds: { skillReflection: true } } })
    const learning = { ...ready, effective: { ...ready.effective, learning: { enabled: true, maxInputChars: 1 } } }
    expect(status({ ...learning, learningDraft: { model: null } }, "learning")).toEqual({
      tone: "waiting",
      key: "Active · waiting for a model to draft skills with",
    })
    expect(status({ ...learning, learningDraft: { model: "openai/mini" } }, "learning").tone).toBe("active")
  })

  test("an acting card says what it does", () => {
    expect(status(view(), "context").key).toBe("Active · observing, nothing is changed")
    expect(status(view({ context: { enabled: true, apply: true } }), "context").key).toBe(
      "Active · trimming what the agent sees",
    )
  })

  test("no first-level wording carries jargon or a field path", () => {
    setLocale("en")
    const words = [
      ...CAPABILITIES.flatMap((capability) => [
        capability.title,
        capability.description,
        ...capability.choices.map((choice) => choice.label),
      ]),
      status(view({ relevance: { enabled: true } }), "suggestions", ["adaptive-config"]).key,
      status(view({ learning: { enabled: true, maxInputChars: 1 } }), "learning").key,
      problemKey("env-disabled"),
      problemKey("no-adaptive-token"),
      problemKey("egress-allowlist"),
    ]
    for (const word of words) expect(word).not.toMatch(/Jev|shadow|egress|token|FLUPCODE|\w+\.\w+/i)
  })

  test("every derived state is translated in Spanish", () => {
    setLocale("es")
    try {
      const keys = [
        status(view(), "context").key,
        status(view({ relevance: { enabled: true }, enabled: false }), "suggestions").key,
        status(view({ relevance: { enabled: true } }), "suggestions", ["adaptive-config"]).key,
        ...CAPABILITIES.flatMap((capability) => [capability.title, capability.description]),
      ]
      for (const key of keys) expect(t(key)).not.toBe(key)
    } finally {
      setLocale("en")
    }
  })
})

describe("the Learning card's freeze and limits (AH-F03)", () => {
  const FROZEN: AdaptiveWritableField = { path: "learning.frozen", type: "boolean", confirmation: "none", guard: "none" }
  const learning = (over: Partial<AdaptiveConfigView["effective"]["learning"]> = {}, extra: Partial<AdaptiveConfigView> = {}) => {
    const ready = consenting({ jev: { projects: ["/p"], kinds: { skillReflection: true } } })
    return {
      ...ready,
      writable: [...WRITABLE, FROZEN],
      learningDraft: { model: "openai/mini" },
      effective: { ...ready.effective, learning: { enabled: true, maxInputChars: 1, ...over } },
      ...extra,
    }
  }
  const reached = {
    learningLimits: {
      reached: [
        { projectID: "/work/app", limit: "proposals-per-day" as const, used: 5, max: 5 },
        { projectID: "C:\\work\\api", limit: "learned-skills" as const, used: 20, max: 20 },
        { projectID: "/work/app", limit: "patches-per-week" as const, used: 5, max: 5 },
      ],
    },
  }

  test("a frozen card says it is frozen, and that pending proposals and learned skills are untouched", () => {
    expect(capabilityStatus(learning({ frozen: true }), ACTING, card("learning"))).toEqual({
      tone: "waiting",
      key: "Frozen · no new proposals. Pending ones can still be reviewed, and learned skills stay in use.",
    })
    // Frozen is not off: the card's own choice stays on Proposing.
    expect(capabilityChoice(learning({ frozen: true }), card("learning"))).toBe("proposing")
    expect(capabilityStatus(learning({ frozen: false }), ACTING, card("learning")).key).toBe(
      "Active · proposing skills for your approval",
    )
  })

  test("the freeze is the card's own switch: not in Advanced, and it asks nothing", () => {
    const current = learning()
    expect(advancedFields(current).map((field) => field.path)).not.toContain("learning.frozen")
    expect(needsConfirmation("learning.frozen", true, current)).toBe(false)
    expect(patchLeaf("learning.frozen", true)).toEqual({ learning: { frozen: true } })
    expect(leafOn(learning({ frozen: true }), "learning.frozen")).toBe(true)
  })

  test("each limit reached is one line naming the project folder and the count", () => {
    expect(learningLimitLines(learning({}, reached))).toEqual([
      {
        key: "Paused in {project}: {used} proposals in the last 24 hours, the daily limit.",
        params: { project: "app", used: 5 },
        path: "/work/app",
      },
      {
        key: "No new skills in {project}: {used} learned skills, the limit. Improving the existing ones continues.",
        params: { project: "api", used: 20 },
        path: "C:\\work\\api",
      },
      {
        key: "No more skill improvements in {project}: {used} in the last 7 days, the weekly limit.",
        params: { project: "app", used: 5 },
        path: "/work/app",
      },
    ])
    setLocale("en")
    expect(t(learningLimitLines(learning({}, reached))[0]!.key, learningLimitLines(learning({}, reached))[0]!.params)).toBe(
      "Paused in app: 5 proposals in the last 24 hours, the daily limit.",
    )
  })

  test("no limit line while learning is off or frozen, or from an older server", () => {
    expect(learningLimitLines(learning({ enabled: false }, reached))).toEqual([])
    expect(learningLimitLines(learning({ frozen: true }, reached))).toEqual([])
    expect(learningLimitLines(learning())).toEqual([])
  })

  test("the freeze and limit copy is plain and translated", () => {
    const keys = [
      capabilityStatus(learning({ frozen: true }), ACTING, card("learning")).key,
      ...learningLimitLines(learning({}, reached)).map((line) => line.key),
      "Freeze learning",
      "Stops new proposals without turning learning off: you can still review pending ones, and learned skills stay in use.",
    ]
    for (const key of keys) expect(key).not.toMatch(/Jev|shadow|egress|token|FLUPCODE|\w+\.\w+/i)
    setLocale("es")
    try {
      for (const key of keys) expect(t(key)).not.toBe(key)
    } finally {
      setLocale("en")
    }
  })
})

describe("the predictive model's state", () => {
  test("not configured until it or a provider's consent is on", () => {
    expect(predictiveStatus(view()).key).toBe("Not configured")
  })

  test("on without its key is active but waiting", () => {
    expect(predictiveStatus(view({ jev: { enabled: true } }))).toEqual({
      tone: "waiting",
      key: "Active · waiting for the model key",
    })
  })

  test("paused for low value when the value gate pauses every decision it serves", () => {
    const on = { ...view({ jev: { enabled: true } }), env: { adaptiveDisabled: false, typesafeKeyPresent: true } }
    expect(predictiveStatus(on).key).toBe("Active · in use")
    expect(predictiveStatus(on, snapshot([gate("completion", "paused"), gate("contextItem", "paused")])).key).toBe(
      "Paused: it is not adding enough value",
    )
    const partly = predictiveStatus(on, snapshot([gate("completion", "paused"), gate("contextItem", "asking")]))
    expect(t(partly.key, partly.params)).toBe("Active · paused for 1 of 2 decisions, for low value")
    expect(predictiveStatus(on, { ...snapshot([gate("completion", "paused")]), enabled: false }).key).toBe(
      "Active · in use",
    )
  })

  test("the level off makes it inactive with that reason", () => {
    expect(predictiveStatus(view({ jev: { enabled: true }, enabled: false })).key).toBe("Inactive: the level is Off.")
  })

  test("its cost is the value gate's, rounded for reading", () => {
    expect(
      predictiveCost(snapshot([gate("completion", "asking", 0.0012), gate("contextItem", "asking", 0.0009)])),
    ).toBe("0.0021")
    expect(predictiveCost(snapshot([gate("completion", "asking", 1.234)]))).toBe("1.23")
    expect(predictiveCost(undefined)).toBe("0.0000")
  })
})

describe("reading a leaf", () => {
  test("a nested boolean, a consent and a missing leaf", () => {
    expect(leafOn(view(), "context.enabled")).toBe(true)
    expect(leafOn(view(), "context.apply")).toBe(false)
    expect(leafOn(consenting({ jev: { enabled: true } }), "egress.providers.jev.enabled")).toBe(true)
    expect(leafOn(view(), "toolTrim.enabled")).toBe(false)
  })
})
