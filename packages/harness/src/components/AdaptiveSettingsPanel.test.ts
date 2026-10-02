import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  KIND_LABELS,
  advancedFields,
  assignableModels,
  assignedModel,
  assignmentLeaves,
  missingForKind,
  modelKinds,
  modelName,
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
  missingFor,
  missingText,
  modelKeyState,
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
    guard: "none",
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

  test("learning needs no classifier consent: without it, the built-in rules propose", () => {
    const field = writableField(view(), "learning.enabled")!
    expect(fieldProblem(field, view(), [])).toBeUndefined()
    expect(fieldProblem(field, consenting({ jev: { projects: ["/p"] } }), [])).toBeUndefined()
    // Even a descriptor that still names the old guard is not blocked by the panel.
    expect(fieldProblem({ ...field, guard: "egress-allowlist" }, view(), [])).toBeUndefined()
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

  test("with the built-in rules, the learning dialog says nothing is sent, and where drafts would go", () => {
    const builtIn = {
      ...view(),
      learningDraft: { model: "openai/gpt-4o-mini" },
      learningClassifier: { model: null, ready: false },
    }
    const message = confirmationMessage("learning.enabled", true, builtIn)
    expect(message).toContain("built-in rules on this machine, so nothing is sent")
    expect(message).toContain("openai/gpt-4o-mini")
    const noDraft = confirmationMessage("learning.enabled", true, { ...builtIn, learningDraft: { model: null } })
    expect(noDraft).toContain("so nothing is sent")
    expect(noDraft).toContain("small model's provider")
    // On the model path the dialog is the draft's own.
    const modelPath = { ...builtIn, learningClassifier: { model: "jev", ready: true } }
    expect(confirmationMessage("learning.enabled", true, modelPath)).toStartWith("Learning drafts a skill")
  })

  test("the learning dialog says what is sent and to which model", () => {
    const withModel = { ...view(), learningDraft: { model: "openai/gpt-4o-mini" } }
    const message = confirmationMessage("learning.enabled", true, withModel)
    expect(message).toContain("8000 characters")
    expect(message).toContain("objective and evidence")
    expect(message).toContain("openai/gpt-4o-mini")
    const withoutModel = confirmationMessage("learning.enabled", true, { ...view(), learningDraft: { model: null } })
    expect(withoutModel).toContain("small model's provider")
    expect(withoutModel).toContain("until one is the built-in rules propose skills on this machine")
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
      "invalid-key",
      "vault-unavailable",
      "invalid-endpoint",
      "unknown-model",
    ]
    for (const code of codes) expect(feedbackFor(code).message).not.toBe("The change could not be saved.")
  })

  test("the warnings the server sends have their own words", () => {
    expect(warningKey("skills-still-load")).toBe("Learned skills still load from disk.")
    expect(warningKey("learning-draft-egress")).toBe(
      "Learning drafts are sent, redacted, to the configured small model's provider.",
    )
    expect(warningKey("classifier-no-consent")).toBe(
      "The predictive model cannot review sessions, so skills are proposed with built-in rules on this machine.",
    )
    expect(warningKey("evaluation-gated")).toBe("Applying is configured, but promotion waits for the offline evaluation.")
    expect(warningKey("model-no-consent")).toBe(
      "The model is chosen, but it cannot receive this decision until you allow sharing it with its provider. Built-in rules decide meanwhile.",
    )
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
    expect(t(text.key, text.params)).toBe("The engine changed from version 1.2.3 to 1.3.0.")
  })

  // For the engine running now the probe has already answered, so there is nothing left to check by hand.
  test("the engine running now says whether FlupCode's plugins answered from it", () => {
    const alert = { kind: "engine-version-changed" as const, from: "1.18.33", to: "2.0.18", at: 1 }
    const confirmed = runtimeAlertText(alert, true)
    expect(t(confirmed.key, confirmed.params)).toContain("FlupCode's plugins answered from it")
    const silent = runtimeAlertText(alert, false)
    expect(t(silent.key, silent.params)).toContain("have not answered from it yet")
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
      for (const alert of alerts)
        for (const hooksFire of [undefined, true, false]) {
          const text = runtimeAlertText(alert, hooksFire)
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
    // Proposing needs no consent: without it the built-in rules propose (AH-F01).
    const proposing = capabilityChoices(view(), card("learning"))[1]!
    expect(choiceProblem(view(), ACTING, proposing)).toBeUndefined()
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

/** Learning on, once per path the card can say: built-in rules (no model, no permission, no draft) or the model. */
const LEARNING_PATHS: AdaptiveConfigView[] = [
  { model: null, ready: false, draft: "openai/mini" },
  { model: "jev", ready: false, draft: "openai/mini" },
  { model: "jev", ready: true, draft: null },
  { model: "jev", ready: true, draft: "openai/mini" },
].map((path) => ({
  ...view({ learning: { enabled: true, maxInputChars: 1 } }),
  learningDraft: { model: path.draft },
  learningClassifier: { model: path.model, ready: path.ready },
}))

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
  })

  test("the runtime only makes the hook-based capabilities inert", () => {
    const v2 = view({ guardrails: { enabled: true } })
    const onV2 = { ...v2, runtime: { ...v2.runtime, runtime: "v2" as const } }
    expect(status(onV2, "loops").tone).toBe("inactive")
    expect(status(onV2, "context").tone).toBe("active")
  })

  test("learning says which path proposes: the built-in rules or the predictive model", () => {
    const on = view({ learning: { enabled: true, maxInputChars: 1 } })
    const draft = { learningDraft: { model: "openai/mini" } }
    expect(status({ ...on, ...draft, learningClassifier: { model: null, ready: false } }, "learning")).toEqual({
      tone: "active",
      key: "Active · proposing skills with built-in rules: no predictive model is set to review sessions",
    })
    expect(status({ ...on, ...draft, learningClassifier: { model: "jev", ready: false } }, "learning")).toEqual({
      tone: "active",
      key: "Active · proposing skills with built-in rules: the predictive model has no permission to review sessions",
    })
    // The built-in rules draft nothing, so a missing drafting model does not matter on that path.
    expect(
      status({ ...on, learningDraft: { model: null }, learningClassifier: { model: null, ready: false } }, "learning")
        .tone,
    ).toBe("active")
    expect(status({ ...on, ...draft, learningClassifier: { model: "jev", ready: true } }, "learning")).toEqual({
      tone: "active",
      key: "Active · proposing skills with the predictive model, for your approval",
    })
    expect(
      status({ ...on, learningDraft: { model: null }, learningClassifier: { model: "jev", ready: true } }, "learning"),
    ).toEqual({
      tone: "waiting",
      key: "Active · proposing skills with built-in rules until there is a model to draft them with",
    })
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
      ...LEARNING_PATHS.map((current) => status(current, "learning").key),
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
        ...LEARNING_PATHS.map((current) => status(current, "learning").key),
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

/** The registry as the server serves it (AH-C01), with the names a reader is shown. */
const MODELS = [
  { id: "jev", name: "Jev", locality: "remote" as const, supports: ["completion", "skillRelevance", "contextItem", "skillReflection", "failure"], needsConsent: true, needsKey: true },
  { id: "small-llm", name: "Small model (through the engine)", locality: "remote" as const, supports: ["skillRelevance", "completion", "failure"], needsConsent: true, needsKey: false },
]
const MODEL_FIELD: AdaptiveWritableField = { path: "models.*", type: "model", confirmation: "none", guard: "none", warning: "model-no-consent" }

/** A view with the registry, the given assignments and consents, and whether the key is set. */
const assigning = (
  models: Record<string, string>,
  providers: Record<string, Partial<{ enabled: boolean; projects: string[]; kinds: Record<string, boolean> }>> = {},
  key = false,
  jevEnabled = false,
): AdaptiveConfigView => {
  const base = consenting(providers)
  return {
    ...base,
    models: MODELS,
    writable: [...WRITABLE, MODEL_FIELD],
    env: { adaptiveDisabled: false, typesafeKeyPresent: key },
    effective: { ...base.effective, models, jev: { enabled: jevEnabled } },
  }
}
const ALLOWED = { enabled: true, projects: ["/p"], kinds: { completion: true, skillRelevance: true } }

describe("the predictive models' state, from the assignments", () => {
  test("not configured while no decision has a model", () => {
    expect(predictiveStatus(view()).key).toBe("Not configured")
    // Consent alone assigns nothing.
    expect(predictiveStatus(assigning({}, { jev: ALLOWED })).key).toBe("Not configured")
  })

  test("says which model answers each decision by its name, and what each still waits for", () => {
    const status = predictiveStatus(assigning({ skillRelevance: "small-llm", completion: "jev" }, { jev: ALLOWED, "small-llm": ALLOWED }))
    expect(status.tone).toBe("active")
    expect(t(status.key, status.params)).toBe(
      "Whether the task is finished: Jev (key missing) · Which skills fit: Small model (through the engine)",
    )
    const waiting = predictiveStatus(assigning({ completion: "small-llm" }))
    expect(waiting.tone).toBe("waiting")
    expect(t(waiting.key, waiting.params)).toBe("Whether the task is finished: Small model (through the engine) (needs permission)")
  })

  test("the legacy single switch reads as every decision answered by Jev", () => {
    const legacy = assigning({ completion: "jev", skillRelevance: "jev", contextItem: "jev", skillReflection: "jev" }, { jev: ALLOWED }, true, true)
    const status = predictiveStatus(legacy)
    expect(t(status.key, status.params)).toBe(
      "Whether the task is finished: Jev · Which skills fit: Jev · Which context to keep: Jev (needs permission) · Whether a session is worth learning from: Jev (needs permission)",
    )
  })

  test("paused for low value when the value gate pauses every decision it serves", () => {
    const on = assigning({ completion: "jev" }, { jev: ALLOWED }, true)
    expect(t(predictiveStatus(on).key, predictiveStatus(on).params)).toBe("Whether the task is finished: Jev")
    expect(predictiveStatus(on, snapshot([gate("completion", "paused"), gate("contextItem", "paused")])).key).toBe(
      "Paused: it is not adding enough value",
    )
    const partly = predictiveStatus(on, snapshot([gate("completion", "paused"), gate("contextItem", "asking")]))
    expect(t(partly.key, partly.params)).toBe("Active · paused for 1 of 2 decisions, for low value")
  })

  test("the level off makes it inactive with that reason", () => {
    const off = assigning({ completion: "jev" })
    expect(predictiveStatus({ ...off, effective: { ...off.effective, enabled: false } }).key).toBe("Inactive: the level is Off.")
  })

  test("reads the same in Spanish, the model names included", () => {
    setLocale("es")
    try {
      const status = predictiveStatus(assigning({ skillRelevance: "small-llm", completion: "jev" }, { "small-llm": ALLOWED }))
      expect(t(status.key, status.params)).toBe(
        "Si la tarea está terminada: Jev (falta permiso) · Qué skills encajan: Modelo pequeño (a través del motor)",
      )
    } finally {
      setLocale("en")
    }
  })

  test("its cost is the value gate's, rounded for reading", () => {
    expect(
      predictiveCost(snapshot([gate("completion", "asking", 0.0012), gate("contextItem", "asking", 0.0009)])),
    ).toBe("0.0021")
    expect(predictiveCost(snapshot([gate("completion", "asking", 1.234)]))).toBe("1.23")
    expect(predictiveCost(undefined)).toBe("0.0000")
  })
})

describe("choosing a model per decision (AH-C01)", () => {
  test("every kind a registered model answers gets a selector, in the order of their plain names", () => {
    expect(modelKinds(assigning({}))).toEqual(["completion", "skillRelevance", "contextItem", "skillReflection", "failure"])
    const all = {
      ...assigning({}),
      models: [{ ...MODELS[0]!, supports: ["futureKind", "failure", "completion"] }],
    }
    // A kind this build has no name for yet still gets its row, after the named ones.
    expect(modelKinds(all)).toEqual(["completion", "failure", "futureKind"])
    // An older server that does not serve its registry keeps the four kinds it shipped with.
    expect(modelKinds(view())).toEqual(["completion", "skillRelevance", "contextItem", "skillReflection"])
  })

  test("every assignable kind has a plain name in both languages, with no jargon", () => {
    for (const kind of ["completion", "skillRelevance", "contextItem", "skillReflection", "failure"]) {
      const label = KIND_LABELS[kind]!
      expect(label).toBeDefined()
      expect(label).not.toMatch(/Jev|shadow|egress|skillRelevance|\w+\.\w+/i)
      setLocale("es")
      expect(t(label)).not.toBe(label)
      setLocale("en")
    }
  })

  test("the summary lists every assigned kind, the ones beyond the first four included", () => {
    const status = predictiveStatus(assigning({ failure: "small-llm" }, { "small-llm": { enabled: true, projects: ["/p"], kinds: { failure: true } } }))
    expect(t(status.key, status.params)).toBe("Why a step failed: Small model (through the engine)")
  })

  test("the selector is offered only when the server lists models.*", () => {
    expect(writableField(assigning({}), "models.completion")?.path).toBe("models.*")
    expect(writableField(view(), "models.completion")).toBeUndefined()
  })

  test("each decision offers the registered models that can answer it, by their names", () => {
    const current = assigning({})
    expect(assignableModels(current, "completion").map((model) => modelName(current, model.id))).toEqual([
      "Jev",
      "Small model (through the engine)",
    ])
    expect(assignableModels(current, "contextItem").map((model) => model.id)).toEqual(["jev"])
    // An id the registry does not name is shown as it is: it is data, not copy.
    expect(modelName(current, "other")).toBe("other")
    expect(modelName(view(), "jev")).toBe("jev")
  })

  test("the selector shows the effective assignment, the legacy switch's included", () => {
    const legacy = assigning({ completion: "jev", skillRelevance: "jev" }, {}, false, true)
    expect(assignedModel(legacy, "completion")).toBe("jev")
    expect(assignedModel(assigning({}), "completion")).toBeUndefined()
  })

  test("a choice writes its own leaf, and null for none", () => {
    expect(assignmentLeaves(assigning({ completion: "jev" }), "skillRelevance", "small-llm")).toEqual({
      "models.skillRelevance": "small-llm",
    })
    expect(assignmentLeaves(assigning({ completion: "jev" }), "completion", null)).toEqual({ "models.completion": null })
  })

  test("under the legacy switch the first choice writes every assignment explicitly and turns the switch off", () => {
    const legacy = assigning({ completion: "jev", skillRelevance: "jev", failure: "jev" }, {}, false, true)
    const leaves = assignmentLeaves(legacy, "skillRelevance", "small-llm")
    expect(leaves).toEqual({
      "models.completion": "jev",
      "models.skillRelevance": "small-llm",
      "models.failure": "jev",
      "jev.enabled": false,
    })
    // One patch, with no confirmation: turning a switch off and assigning are not consent.
    expect(Object.entries(leaves).some(([path, value]) => needsConfirmation(path, value, legacy))).toBe(false)
    expect(patchOf(leaves)).toEqual({
      models: { completion: "jev", skillRelevance: "small-llm", failure: "jev" },
      jev: { enabled: false },
    })
  })

  test("each row says what its model still needs: its provider's project, this decision, sending data, the key", () => {
    const said = (current: AdaptiveConfigView, kind: string, id: string) => {
      const items = missingForKind(current, kind, id)
      return items.length > 0 ? missingText(items) : undefined
    }
    expect(said(assigning({}), "completion", "jev")).toBe(
      "Missing: a project, this decision allowed for Jev, sending data to Jev turned on, and the model key",
    )
    expect(said(assigning({}, { jev: ALLOWED }), "completion", "jev")).toBe("Missing: the model key")
    expect(said(assigning({}, { jev: ALLOWED }, true), "completion", "jev")).toBeUndefined()
    // Consent is per decision: Jev may decide completion, not which context to keep.
    expect(said(assigning({}, { jev: ALLOWED }, true), "contextItem", "jev")).toBe("Missing: this decision allowed for Jev")
    // The small model needs no key.
    expect(said(assigning({}, { "small-llm": { projects: ["/p"] } }), "completion", "small-llm")).toBe(
      "Missing: this decision allowed for Small model (through the engine) and sending data to Small model (through the engine) turned on",
    )
  })

  test("a local model needs no consent", () => {
    const local = { ...assigning({}), models: [{ id: "local-embed", name: "Local", locality: "local" as const, supports: ["contextItem"], needsConsent: false, needsKey: false }] }
    expect(missingForKind(local, "contextItem", "local-embed")).toEqual([])
  })

  test("every provider-facing text uses the display name, never the raw id", () => {
    const current = assigning({}, { "small-llm": {} })
    const texts = [
      confirmationMessage("egress.providers.jev.enabled", true, current),
      confirmationMessage("egress.providers.small-llm.projects", ["/p"], current),
      confirmationMessage("egress.providers.small-llm.kinds", { completion: true }, current),
      missingText(missingFor(current, "jev.enabled")),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/\bjev\b|small-llm/)
    }
    expect(texts[0]).toContain("covers Jev only")
    expect(texts[1]).toContain("Small model (through the engine) may then receive")
  })

  test("the selector's words are translated", () => {
    setLocale("es")
    try {
      for (const key of [
        "Which model answers each decision",
        "None (built-in rules)",
        "this decision allowed for {provider}",
        "needs permission",
        "key missing",
        "Small model (through the engine)",
        "These choices come from the older single switch. Changing one saves a choice per decision and turns that switch off.",
      ])
        expect(t(key)).not.toBe(key)
      expect(modelName(assigning({}), "small-llm")).toBe("Modelo pequeño (a través del motor)")
      expect(modelName(assigning({}), "jev")).toBe("Jev")
    } finally {
      setLocale("en")
    }
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

describe("what a blocked switch says is missing", () => {
  const keyed = (base: AdaptiveConfigView): AdaptiveConfigView => ({
    ...base,
    env: { adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "stored" },
  })
  const said = (base: AdaptiveConfigView, path: string) => {
    const items = missingFor(base, path)
    return items.length > 0 ? missingText(items) : undefined
  }

  test("the predictive model names every missing step, in the order the section draws them", () => {
    const cases: Array<[Partial<{ enabled: boolean; projects: string[]; kinds: Record<string, boolean> }>, string | undefined]> = [
      [{}, "Missing: a project, a decision, and sending data to jev turned on"],
      [{ projects: ["/p"] }, "Missing: a decision and sending data to jev turned on"],
      [{ kinds: { completion: true } }, "Missing: a project and sending data to jev turned on"],
      [{ projects: ["/p"], kinds: { completion: true } }, "Missing: sending data to jev turned on"],
      [{ enabled: true }, "Missing: a project and a decision"],
      [{ enabled: true, projects: ["/p"] }, "Missing: a decision"],
      [{ enabled: true, kinds: { completion: true } }, "Missing: a project"],
      [{ enabled: true, projects: ["/p"], kinds: { completion: true } }, undefined],
      // A decision turned off is no decision.
      [{ enabled: true, projects: ["/p"], kinds: { completion: false } }, "Missing: a decision"],
    ]
    for (const [consent, text] of cases) expect(said(keyed(consenting({ jev: consent })), "jev.enabled")).toBe(text)
  })

  test("without a key the predictive model says so last, and with everything else it is the only thing", () => {
    expect(said(consenting({}), "jev.enabled")).toBe(
      "Missing: a project, a decision, sending data to jev turned on, and the model key",
    )
    expect(
      said(consenting({ jev: { enabled: true, projects: ["/p"], kinds: { completion: true } } }), "jev.enabled"),
    ).toBe("Missing: the model key")
  })

  test("sending data to a provider needs a project and a decision of that provider's own", () => {
    const base = consenting({ jev: { projects: ["/p"], kinds: { completion: true } }, "small-llm": {} })
    expect(said(base, "egress.providers.small-llm.enabled")).toBe("Missing: a project and a decision")
    expect(said(base, "egress.providers.jev.enabled")).toBeUndefined()
    expect(said(consenting({ "small-llm": { projects: ["/p"] } }), "egress.providers.small-llm.enabled")).toBe(
      "Missing: a decision",
    )
    expect(said(consenting({ "small-llm": { kinds: { completion: true } } }), "egress.providers.small-llm.enabled")).toBe(
      "Missing: a project",
    )
    // Sending data is not itself a step it waits for, and its key is the predictive model's concern.
    expect(said(base, "egress.providers.jev.enabled")).toBeUndefined()
  })

  test("any other switch has nothing of this kind missing", () => {
    expect(missingFor(consenting({}), "retention.enabled")).toEqual([])
    expect(missingFor(consenting({}), "egress.providers.jev.projects")).toEqual([])
  })

  test("the sentence is joined the Spanish way in Spanish, with the provider's name kept as data", () => {
    setLocale("es")
    expect(said(consenting({}), "jev.enabled")).toBe(
      "Falta: un proyecto, una decisión, el envío de datos a jev activado y la clave del modelo",
    )
    setLocale("en")
  })
})

describe("where the predictive model's key stands", () => {
  const withKey = (env: AdaptiveConfigView["env"], storable?: boolean): AdaptiveConfigView => ({
    ...view(),
    env,
    ...(storable === undefined ? {} : { modelKeyStorable: storable }),
  })

  test("set by the environment, saved, missing, or missing where it cannot be saved", () => {
    expect(modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "env" }, true))).toBe(
      "env",
    )
    expect(
      modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "stored" }, true)),
    ).toBe("stored")
    expect(modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: false, typesafeKeySource: "none" }, true))).toBe(
      "none",
    )
    expect(
      modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: false, typesafeKeySource: "none" }, false)),
    ).toBe("unavailable")
  })

  test("an older server that only says whether a key exists is read as the environment's, or as unsavable", () => {
    expect(modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: true }))).toBe("env")
    expect(modelKeyState(withKey({ adaptiveDisabled: false, typesafeKeyPresent: false }))).toBe("unavailable")
  })

  test("every key message is translated", () => {
    setLocale("es")
    for (const key of [
      "Key set by the environment.",
      "Key saved",
      "Save key",
      "Model key",
      "Predictive model key",
      "The key is stored encrypted on this machine and used only for calls to the predictive model's provider. It is never shown again.",
    ])
      expect(t(key)).not.toBe(key)
    setLocale("en")
  })
})
