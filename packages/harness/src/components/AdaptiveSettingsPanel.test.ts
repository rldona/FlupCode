import { describe, expect, test } from "bun:test"
import {
  feedbackFor,
  fieldProblem,
  needsConfirmation,
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
  { path: "learning.enabled", type: "boolean", confirmation: "none", guard: "egress-allowlist" },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
]

const view = (over: Partial<AdaptiveConfigView["effective"]> = {}, envDisabled = false): AdaptiveConfigView => ({
  effective: {
    enabled: true,
    shadow: false,
    context: { enabled: true, apply: false },
    learning: { enabled: false },
    relevance: { enabled: false },
    jev: { enabled: false },
    egress: { projects: [], kinds: {} },
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

  test("learning needs a project and skillReflection in the allowlist", () => {
    const field = writableField(view(), "learning.enabled")!
    expect(fieldProblem(field, view(), [])).toBe("egress-allowlist")
    expect(fieldProblem(field, view({ egress: { projects: ["/p"], kinds: {} } }), [])).toBe("egress-allowlist")
    expect(
      fieldProblem(field, view({ egress: { projects: ["/p"], kinds: { skillReflection: true } } }), []),
    ).toBeUndefined()
  })

  test("jev needs any project and any kind", () => {
    const field = writableField(view(), "jev.enabled")!
    expect(fieldProblem(field, view(), [])).toBe("egress-allowlist")
    expect(fieldProblem(field, view({ egress: { projects: ["/p"], kinds: { completion: true } } }), [])).toBeUndefined()
  })

  test("a field the server does not list is never found", () => {
    expect(writableField(view(), "runtime.timeoutMs")).toBeUndefined()
  })

  test("a field whose guard is met is offered", () => {
    expect(fieldProblem(writableField(view(), "context.apply")!, view(), [])).toBeUndefined()
    expect(fieldProblem(writableField(view(), "egress.projects")!, view(), [])).toBeUndefined()
    expect(fieldProblem(writableField(view(), "shadow")!, view(), [])).toBeUndefined()
  })
})

describe("which writes need confirming", () => {
  test("retention and jev only when they are being turned on", () => {
    expect(needsConfirmation("retention.enabled", true, view())).toBe(true)
    expect(needsConfirmation("retention.enabled", false, view())).toBe(false)
    expect(needsConfirmation("jev.enabled", true, view())).toBe(true)
  })

  test("egress only when it widens", () => {
    const before = view({ egress: { projects: ["/p"], kinds: { completion: true } } })
    expect(needsConfirmation("egress.projects", ["/p", "/q"], before)).toBe(true)
    expect(needsConfirmation("egress.projects", ["/p"], before)).toBe(false)
    expect(needsConfirmation("egress.projects", [], before)).toBe(false)
    expect(needsConfirmation("egress.kinds", { completion: true, skillRelevance: true }, before)).toBe(true)
    expect(needsConfirmation("egress.kinds", { completion: false }, before)).toBe(false)
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
      "Relevance needs the acting token, which this server does not have.",
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
