import { describe, expect, test } from "bun:test"
import {
  confirmationMessage,
  feedbackFor,
  fieldProblem,
  inactiveByMaster,
  needsConfirmation,
  nextBudgetDraft,
  patchLeaf,
  problemKey,
  refusedField,
  sourceKey,
  warningKey,
  writableField,
} from "./AdaptiveSettingsPanel"
import { AdaptiveConfigError } from "../client"
import type { AdaptiveConfigView, AdaptiveWritableField } from "../types"

const WRITABLE: AdaptiveWritableField[] = [
  { path: "enabled", type: "boolean", confirmation: "none", guard: "env-disabled" },
  { path: "shadow", type: "boolean", confirmation: "none", guard: "none" },
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
    expect(problemKey("env-disabled")).toBe("Disabled by FLUPCODE_ADAPTIVE_DISABLED=1")
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
      "Enabling this needs the provider's egress consent, with a project and a kind, first.",
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
    expect(problemKey("no-adaptive-token")).toBe("This switch needs the acting token, which this server does not have.")
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
    expect(confirmationMessage("retention.enabled", true, view())).toBe(
      "Writing to retention.enabled needs confirmation. The change is written to the config file.",
    )
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
      "This switch needs the acting token, which this server does not have.",
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
