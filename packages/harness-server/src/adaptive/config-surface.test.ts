import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { createAdaptiveConfig, resolveAdaptiveConfig } from "./config"
import {
  AdaptiveConfigError,
  WRITABLE_FIELDS,
  adaptiveConfigView,
  adaptiveSource,
  createAdaptiveConfigSurface,
  planAdaptivePatch,
  writerTarget,
} from "./config-surface"
import type { AdaptiveConfigViewInput } from "./config-surface"
import type { RuntimeCapabilities } from "./runtime"

const capabilities: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: 0,
}

type PlanInput = Parameters<typeof planAdaptivePatch>[0]
type PlanOverrides = Partial<PlanInput> & { patch: Record<string, unknown> }

/** A full plan input with the common defaults, so each test states only what it is about. */
const base = (input: PlanOverrides): PlanInput => ({
  confirm: false,
  block: {},
  env: {},
  adaptiveTokenPresent: true,
  runtimeKind: "legacy",
  ...input,
})

const plan = (input: PlanOverrides) => planAdaptivePatch(base(input))

/** The rejection a plan throws, or a failure when it did not throw. */
const rejection = (input: PlanOverrides): AdaptiveConfigError => {
  try {
    planAdaptivePatch(base(input))
  } catch (cause) {
    if (cause instanceof AdaptiveConfigError) return cause
    throw cause
  }
  throw new Error("the patch was not refused")
}

describe("the writable allowlist", () => {
  test("names exactly the E8 switches", () => {
    expect(WRITABLE_FIELDS.map((field) => field.path)).toEqual([
      "enabled",
      "shadow",
      "context.enabled",
      "context.apply",
      "learning.enabled",
      "relevance.enabled",
      "guardrails.enabled",
      "jev.enabled",
      "egress.providers.*.enabled",
      "egress.providers.*.projects",
      "egress.providers.*.kinds",
      "retention.enabled",
      "budget.monthlyTokens",
      "compaction.anchors",
    ])
  })

  test("rejects a leaf outside the allowlist without touching anything else", () => {
    const error = rejection({ patch: { runtime: "v2" } })
    expect(error).toMatchObject({ status: 422, code: "unsupported-field", fields: ["runtime"] })
  })

  test("rejects a nested non-allowlisted leaf", () => {
    const error = rejection({ patch: { context: { budget: { total: 10 } } } })
    expect(error.code).toBe("unsupported-field")
    expect(error.fields).toEqual(["context.budget.total"])
  })

  test("rejects a dotted key instead of writing it as one literal field", () => {
    const error = rejection({ patch: { "budget.monthlyTokens": 10 } })
    expect(error).toMatchObject({ code: "unsupported-field", fields: ["budget.monthlyTokens"] })
  })

  test("rejects a nested key whose segment carries a dot", () => {
    const error = rejection({ patch: { context: { "enabled.extra": true } } })
    expect(error.code).toBe("unsupported-field")
    expect(error.fields).toEqual(["context.enabled.extra"])
  })

  test("the legacy top-level egress keys are no longer written: consent is per provider", () => {
    expect(rejection({ patch: { egress: { projects: ["/a"] } } })).toMatchObject({
      code: "unsupported-field",
      fields: ["egress.projects"],
    })
    expect(rejection({ patch: { egress: { kinds: { completion: true } } } }).code).toBe("unsupported-field")
  })

  test("a provider id must be a plain id, never a wildcard or a dotted key", () => {
    for (const id of ["*", "a.b", "bad id", "-lead"])
      expect(rejection({ patch: { egress: { providers: { [id]: { enabled: false } } } } }).code).toBe("unsupported-field")
    expect(rejection({ patch: { egress: { providers: { jev: { endpoint: "x" } } } } })).toMatchObject({
      code: "unsupported-field",
      fields: ["egress.providers.jev.endpoint"],
    })
  })

  test("rejects a patch nested far deeper than any writable field", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }
    expect(rejection({ patch: deep }).code).toBe("unsupported-field")
  })
})

describe("value validation", () => {
  test("a boolean switch only takes booleans or null", () => {
    expect(plan({ patch: { shadow: false } }).leaves).toHaveLength(1)
    expect(rejection({ patch: { shadow: "off" } })).toMatchObject({ code: "invalid-value", fields: ["shadow"] })
  })

  test("a provider's projects take a list of non-empty strings or null", () => {
    const small = (projects: unknown) => ({ egress: { providers: { "small-llm": { projects } } } })
    expect(plan({ patch: small(["/a"]), confirm: true }).leaves).toHaveLength(1)
    expect(rejection({ patch: small(["/a", 7]) })).toMatchObject({
      code: "invalid-value",
      fields: ["egress.providers.small-llm.projects"],
    })
  })

  test("a provider's kinds only accept decision kinds with booleans", () => {
    const small = (kinds: unknown) => ({ egress: { providers: { "small-llm": { kinds } } } })
    expect(plan({ patch: small({ skillReflection: true, completion: false }), confirm: true }).leaves).toHaveLength(1)
    expect(rejection({ patch: small({ nope: true }) }).code).toBe("invalid-value")
    expect(rejection({ patch: small({ completion: "yes" }) }).code).toBe("invalid-value")
  })

  test("budget.monthlyTokens must be a positive number", () => {
    expect(plan({ patch: { budget: { monthlyTokens: 10 } } }).leaves).toHaveLength(1)
    expect(rejection({ patch: { budget: { monthlyTokens: 0 } } }).code).toBe("invalid-value")
    expect(rejection({ patch: { budget: { monthlyTokens: -5 } } }).code).toBe("invalid-value")
  })

  test("null is the explicit deletion of any allowlisted leaf", () => {
    const built = plan({ patch: { relevance: { enabled: null } } })
    expect(built.leaves).toEqual([{ path: "relevance.enabled", segments: ["relevance", "enabled"], value: null }])
  })
})

describe("guards", () => {
  test("enabled is refused under FLUPCODE_ADAPTIVE_DISABLED=1", () => {
    const error = rejection({ patch: { enabled: true }, env: { FLUPCODE_ADAPTIVE_DISABLED: "1" } })
    expect(error).toMatchObject({ code: "env-disabled", fields: ["enabled"] })
  })

  test("enabling relevance needs a resolved adaptive token", () => {
    const error = rejection({ patch: { relevance: { enabled: true } }, adaptiveTokenPresent: false })
    expect(error).toMatchObject({ code: "guard:no-adaptive-token", fields: ["relevance.enabled"] })
    expect(plan({ patch: { relevance: { enabled: true } } }).leaves).toHaveLength(1)
  })

  test("enabling guardrails needs a resolved adaptive token", () => {
    const error = rejection({ patch: { guardrails: { enabled: true } }, adaptiveTokenPresent: false })
    expect(error).toMatchObject({ code: "guard:no-adaptive-token", fields: ["guardrails.enabled"] })
    expect(plan({ patch: { guardrails: { enabled: true } } }).leaves).toHaveLength(1)
  })

  test("enabling learning needs the classifier's consent for a project and skillReflection", () => {
    const error = rejection({ patch: { learning: { enabled: true } } })
    expect(error).toMatchObject({
      code: "guard:egress-allowlist-required",
      fields: ["learning.enabled"],
      missing: ["egress.providers.jev.projects", "egress.providers.jev.kinds.skillReflection"],
    })
    // The consent asked for is the one of the model `skillReflection` is assigned to.
    expect(
      rejection({ patch: { learning: { enabled: true } }, block: { models: { skillReflection: "small-llm" } } }).missing,
    ).toEqual(["egress.providers.small-llm.projects", "egress.providers.small-llm.kinds.skillReflection"])
  })

  test("a local classifier needs no consent for learning", () => {
    const built = plan({
      patch: { learning: { enabled: true } },
      block: { models: { skillReflection: "local-embed" } },
      models: [{ id: "local-embed", locality: "local" }],
      confirm: true,
    })
    expect(built.leaves.map((leaf) => leaf.path)).toEqual(["learning.enabled"])
  })

  test("enabling learning passes when the block already allowlists it", () => {
    const built = plan({
      patch: { learning: { enabled: true } },
      block: { egress: { projects: ["/p"], kinds: { skillReflection: true } } },
      confirm: true,
    })
    expect(built.leaves.map((leaf) => leaf.path)).toEqual(["learning.enabled"])
  })

  test("enabling learning passes when the same patch gives the consent", () => {
    const built = plan({
      patch: {
        egress: { providers: { jev: { projects: ["/p"], kinds: { skillReflection: true } } } },
        learning: { enabled: true },
      },
      confirm: true,
    })
    expect(built.leaves.map((leaf) => leaf.path)).toEqual([
      "egress.providers.jev.enabled",
      "egress.providers.jev.projects",
      "egress.providers.jev.kinds",
      "learning.enabled",
    ])
  })

  test("enabling Jev needs a project and at least one kind", () => {
    const error = rejection({ patch: { jev: { enabled: true } }, confirm: true })
    expect(error).toMatchObject({
      code: "guard:egress-allowlist-required",
      missing: ["egress.providers.jev.projects", "egress.providers.jev.kinds"],
    })
  })

  test("in the new shape, enabling Jev also needs Jev's consent switched on", () => {
    const consent = { projects: ["/p"], kinds: { completion: true } }
    const block = { egress: { providers: { jev: consent } } }
    expect(rejection({ patch: { jev: { enabled: true } }, block, confirm: true }).missing).toEqual([
      "egress.providers.jev.enabled",
    ])
    const on = { egress: { providers: { jev: { ...consent, enabled: true } } } }
    expect(plan({ patch: { jev: { enabled: true } }, block: on, confirm: true }).leaves).toHaveLength(1)
  })

  test("consenting to a provider needs a project and a kind for that provider", () => {
    const error = rejection({ patch: { egress: { providers: { "small-llm": { enabled: true } } } }, confirm: true })
    expect(error).toMatchObject({
      code: "guard:egress-allowlist-required",
      fields: ["egress.providers.small-llm.enabled"],
      missing: ["egress.providers.small-llm.projects", "egress.providers.small-llm.kinds"],
    })
    // Jev's consent is not small-llm's.
    const jevConsent = { jev: { enabled: true }, egress: { projects: ["/p"], kinds: { completion: true } } }
    expect(
      rejection({ patch: { egress: { providers: { "small-llm": { enabled: true } } } }, block: jevConsent, confirm: true })
        .code,
    ).toBe("guard:egress-allowlist-required")
  })

  test("a missing allowlist is refused before confirmation is considered", () => {
    expect(rejection({ patch: { jev: { enabled: true } } }).code).toBe("guard:egress-allowlist-required")
  })
})

describe("confirmation", () => {
  test("retention needs confirmation", () => {
    expect(rejection({ patch: { retention: { enabled: true } } })).toMatchObject({
      code: "confirmation-required",
      fields: ["retention.enabled"],
    })
    expect(plan({ patch: { retention: { enabled: true } }, confirm: true }).leaves).toHaveLength(1)
  })

  test("Jev needs confirmation once its allowlist is satisfied", () => {
    const shared = {
      block: { egress: { projects: ["/p"], kinds: { completion: true } } },
      patch: { jev: { enabled: true } },
    }
    expect(rejection(shared).code).toBe("confirmation-required")
    expect(plan({ ...shared, confirm: true }).leaves).toHaveLength(1)
  })

  test("learning needs confirmation once its allowlist is satisfied: the draft leaves the machine", () => {
    const shared = {
      block: { egress: { projects: ["/p"], kinds: { skillReflection: true } } },
      patch: { learning: { enabled: true } },
    }
    expect(rejection(shared)).toMatchObject({ code: "confirmation-required", fields: ["learning.enabled"] })
    expect(plan({ ...shared, confirm: true }).leaves).toHaveLength(1)
    // Turning it off is never gated behind a dialog.
    expect(plan({ ...shared, patch: { learning: { enabled: false } } }).leaves).toHaveLength(1)
  })

  test("widening a provider's projects needs confirmation, narrowing does not", () => {
    const block = { egress: { providers: { "small-llm": { projects: ["/a", "/c"] } } } }
    const projects = (list: string[]) => ({ egress: { providers: { "small-llm": { projects: list } } } })
    expect(rejection({ patch: projects(["/a", "/b"]), block }).fields).toEqual(["egress.providers.small-llm.projects"])
    expect(plan({ patch: projects(["/a"]), block }).leaves).toHaveLength(1)
  })

  test("turning a provider's kind on needs confirmation, turning one off does not", () => {
    const block = { egress: { providers: { "small-llm": { kinds: { completion: true } } } } }
    const kinds = (on: Record<string, boolean>) => ({ egress: { providers: { "small-llm": { kinds: on } } } })
    expect(rejection({ patch: kinds({ completion: true, failure: true }), block }).fields).toEqual([
      "egress.providers.small-llm.kinds",
    ])
    expect(plan({ patch: kinds({ completion: false }), block }).leaves).toHaveLength(1)
  })

  test("turning a provider's consent on needs confirmation, turning it off does not", () => {
    const block = { egress: { providers: { "small-llm": { projects: ["/p"], kinds: { completion: true } } } } }
    const enabled = (on: boolean) => ({ egress: { providers: { "small-llm": { enabled: on } } } })
    expect(rejection({ patch: enabled(true), block })).toMatchObject({
      code: "confirmation-required",
      fields: ["egress.providers.small-llm.enabled"],
    })
    expect(plan({ patch: enabled(true), block, confirm: true }).leaves).toHaveLength(1)
    expect(plan({ patch: enabled(false), block }).leaves).toHaveLength(1)
  })
})

describe("moving an old config to per-provider consent (AH-C03)", () => {
  const legacy = { jev: { enabled: true }, egress: { projects: ["/p"], kinds: { completion: true } } }

  test("editing Jev's consent carries the legacy consent over, so the move changes nothing else", () => {
    const built = plan({ patch: { egress: { providers: { jev: { projects: ["/p", "/q"] } } } }, block: legacy, confirm: true })
    expect(built.leaves.map((leaf) => [leaf.path, leaf.value])).toEqual([
      ["egress.providers.jev.enabled", true],
      ["egress.providers.jev.kinds", { completion: true }],
      ["egress.providers.jev.projects", ["/p", "/q"]],
    ])
    const after = resolveAdaptiveConfig({ block: built.blockAfter, env: {} })
    expect(after.egress.providers.jev).toMatchObject({ enabled: true, projects: ["/p", "/q"] })
    expect(after.egress.providers.jev?.kinds.completion).toBe(true)
    // The legacy keys are left where they were: no file is rewritten beyond the patch's own provider.
    expect(built.blockAfter).toMatchObject(legacy)
  })

  test("the carried-over leaves ask for no confirmation of their own: only the widening does", () => {
    expect(rejection({ patch: { egress: { providers: { jev: { projects: ["/p", "/q"] } } } }, block: legacy }).fields).toEqual([
      "egress.providers.jev.projects",
    ])
    // Narrowing Jev's consent while moving it is not gated at all.
    expect(plan({ patch: { egress: { providers: { jev: { enabled: false } } } }, block: legacy }).leaves).toHaveLength(3)
  })

  test("consenting to another provider leaves an old config's Jev exactly where it was", () => {
    const patch = {
      egress: { providers: { "small-llm": { enabled: true, projects: ["/p"], kinds: { skillRelevance: true } } } },
    }
    const built = plan({ patch, block: legacy, confirm: true })
    expect(built.leaves.map((leaf) => leaf.path)).toEqual([
      "egress.providers.small-llm.enabled",
      "egress.providers.small-llm.projects",
      "egress.providers.small-llm.kinds",
    ])
    const before = resolveAdaptiveConfig({ block: legacy, env: {} })
    const after = resolveAdaptiveConfig({ block: built.blockAfter, env: {} })
    expect(after.egress.providers.jev).toEqual(before.egress.providers.jev)
    expect(after.models).toEqual(before.models)
  })

  test("enabling small-llm does not enable Jev, and enabling Jev does not enable small-llm", () => {
    const consent = { projects: ["/p"], kinds: { completion: true } }
    const small = plan({
      patch: { egress: { providers: { "small-llm": { enabled: true, ...consent } } } },
      confirm: true,
    })
    const smallAfter = resolveAdaptiveConfig({ block: small.blockAfter, env: {} })
    expect(smallAfter.egress.providers["small-llm"]?.enabled).toBe(true)
    expect(smallAfter.egress.providers.jev?.enabled).toBe(false)
    expect(smallAfter.jev.enabled).toBe(false)
    expect(smallAfter.models).toEqual({})

    const jev = plan({ patch: { egress: { providers: { jev: { enabled: true, ...consent } } } }, confirm: true })
    const jevAfter = resolveAdaptiveConfig({ block: jev.blockAfter, env: {} })
    expect(jevAfter.egress.providers.jev?.enabled).toBe(true)
    expect(jevAfter.egress.providers["small-llm"]).toBeUndefined()
  })
})

describe("warnings", () => {
  test("context.apply warns that promotion is evaluation-gated", () => {
    expect(plan({ patch: { context: { apply: true } } }).warnings).toEqual(["evaluation-gated"])
  })

  test("relevance on a non-legacy runtime warns it is inert", () => {
    expect(plan({ patch: { relevance: { enabled: true } }, runtimeKind: "v2" }).warnings).toEqual(["runtime-inert"])
    expect(plan({ patch: { relevance: { enabled: true } }, runtimeKind: "legacy" }).warnings).toEqual([])
  })

  test("learning always warns the draft egress, and no-model without a model", () => {
    const allowlisted = { egress: { projects: ["/p"], kinds: { skillReflection: true } } }
    expect(plan({ patch: { learning: { enabled: true } }, block: allowlisted, confirm: true }).warnings).toEqual([
      "learning-draft-egress",
      "no-model",
    ])
    expect(
      plan({
        patch: { learning: { enabled: true } },
        block: allowlisted,
        confirm: true,
        smallModel: "openai/gpt-4o-mini",
      }).warnings,
    ).toEqual(["learning-draft-egress"])
  })

  test("the learning switch's descriptor announces its confirmation and its egress warning", () => {
    expect(WRITABLE_FIELDS.find((field) => field.path === "learning.enabled")).toMatchObject({
      confirmation: "required",
      warning: "learning-draft-egress",
    })
  })

  test("turning the master on reminds that learned skills keep loading", () => {
    expect(plan({ patch: { enabled: true } }).warnings).toEqual(["skills-still-load"])
  })
})

describe("source provenance (env > block > default)", () => {
  test("an env kill beats a block value", () => {
    expect(adaptiveSource({ enabled: true }, { FLUPCODE_ADAPTIVE_DISABLED: "1" }).enabled).toBe("env")
  })

  test("a block value is block, an absent one default", () => {
    const source = adaptiveSource({ enabled: false, relevance: { enabled: true } }, {})
    expect(source.enabled).toBe("block")
    expect(source["relevance.enabled"]).toBe("block")
    expect(source["jev.enabled"]).toBe("default")
  })

  test("runtime and episode read their env first", () => {
    const source = adaptiveSource(
      { runtime: "v2", probe: { ttlMs: 1000 }, episode: { cadenceCalls: 9 } },
      {
        FLUPCODE_ADAPTIVE_RUNTIME: "legacy",
        FLUPCODE_ADAPTIVE_PROBE_TTL_MS: "50",
        FLUPCODE_ADAPTIVE_EPISODE_CADENCE_CALLS: "3",
      },
    )
    expect(source["runtime.override"]).toBe("env")
    expect(source["runtime.ttlMs"]).toBe("env")
    expect(source["episode.cadenceCalls"]).toBe("env")
    expect(source["episode.sweepMs"]).toBe("default")
  })

  test("the interactive episode keys report where they come from", () => {
    const source = adaptiveSource(
      { episode: { interactive: true, idleMs: 60_000 } },
      { FLUPCODE_ADAPTIVE_EPISODE_INTERACTIVE: "0" },
    )
    expect(source["episode.interactive"]).toBe("env")
    expect(source["episode.idleMs"]).toBe("block")
    expect(source["episode.sessionLimit"]).toBe("default")
  })

  test("ignores a malformed env value and falls through to the block", () => {
    const source = adaptiveSource({ probe: { ttlMs: 1000 } }, { FLUPCODE_ADAPTIVE_PROBE_TTL_MS: "not-a-number" })
    expect(source["runtime.ttlMs"]).toBe("block")
  })
})

describe("source mirrors the resolver on partial and malformed blocks", () => {
  test("every writable leaf is block only when the block carries its declared type", () => {
    const block = {
      enabled: false,
      shadow: false,
      context: { enabled: false, apply: false },
      learning: { enabled: false },
      relevance: { enabled: false },
      guardrails: { enabled: false },
      jev: { enabled: false },
      retention: { enabled: false },
      egress: { projects: [], kinds: {} },
      budget: { monthlyTokens: 10 },
      compaction: { anchors: false },
    }
    const source = adaptiveSource(block, {})
    for (const field of WRITABLE_FIELDS) expect(source[field.path.replace("*", "jev")]).toBe("block")
  })

  test("a mistyped writable leaf is default and the effective value is its default, not the bad one", () => {
    const block = {
      enabled: "yes",
      shadow: 1,
      context: { enabled: 1, apply: "sure" },
      learning: { enabled: 1 },
      relevance: { enabled: "true" },
      guardrails: { enabled: "true" },
      jev: { enabled: 1 },
      retention: { enabled: 1 },
      egress: { projects: "nope", kinds: [] },
      budget: { monthlyTokens: -5 },
      compaction: { anchors: "off" },
    }
    const source = adaptiveSource(block, {})
    for (const field of WRITABLE_FIELDS) expect(source[field.path.replace("*", "jev")]).toBe("default")

    const effective = resolveAdaptiveConfig({ block, env: {} })
    expect(effective.enabled).toBe(true)
    expect(effective.context.apply).toBe(false)
    expect(effective.learning.enabled).toBe(false)
    expect(effective.relevance.enabled).toBe(false)
    expect(effective.guardrails.enabled).toBe(false)
    expect(effective.jev.enabled).toBe(false)
    expect(effective.retention.enabled).toBe(false)
    expect(effective.egress.providers.jev?.projects).toEqual([])
    expect(Object.values(effective.egress.providers.jev?.kinds ?? {}).some(Boolean)).toBe(false)
    expect(effective.budget.monthlyTokens).toBe(100_000)
  })

  test("a partial egress block reports only the leaves it carries", () => {
    const block = { egress: { projects: ["/a"] } }
    const source = adaptiveSource(block, {})
    expect(source["egress.providers.jev.projects"]).toBe("block")
    expect(source["egress.providers.jev.kinds"]).toBe("default")
    expect(resolveAdaptiveConfig({ block, env: {} }).egress.providers.jev).toEqual({
      enabled: false,
      projects: ["/a"],
      kinds: {
        completion: false,
        skillRelevance: false,
        contextItem: false,
        modelRoute: false,
        agentRoute: false,
        toolRisk: false,
        failure: false,
        skillReflection: false,
      },
    })
  })

  test("the env kill is reported as env and the effective switch is off", () => {
    const block = { enabled: true }
    const env = { FLUPCODE_ADAPTIVE_DISABLED: "1" }
    expect(adaptiveSource(block, env).enabled).toBe("env")
    expect(resolveAdaptiveConfig({ block, env }).enabled).toBe(false)
  })
})

describe("the read model", () => {
  const viewInput = (overrides: Partial<AdaptiveConfigViewInput> = {}): AdaptiveConfigViewInput => ({
    block: {},
    env: {},
    resolved: createAdaptiveConfig({ read: () => ({}), env: {} }).current(),
    runtime: { runtime: "legacy", degraded: false, checkedAt: 0 },
    capabilities,
    usage: { month: "2026-09", tokensSpent: 0, calls: 0, monthlyTokens: 100_000, hotReserveFraction: 0.2 },
    canWrite: true,
    writer: { path: "/cfg/opencode.jsonc", exists: true },
    ...overrides,
  })

  test("assembles the documented shape", () => {
    const view = adaptiveConfigView(viewInput({ env: { TYPESAFE_API_KEY: "k" } }))
    expect(view.env).toEqual({ adaptiveDisabled: false, typesafeKeyPresent: true })
    expect(view.runtime).toEqual({ runtime: "legacy", degraded: false, checkedAt: 0, alerts: [] })
    expect(view.canWrite).toBe(true)
    expect(view.writer).toEqual({ path: "/cfg/opencode.jsonc", exists: true })
    expect(view.usage).toEqual({ month: "2026-09", tokensSpent: 0, calls: 0, monthlyTokens: 100_000, hotReserveFraction: 0.2 })
    expect(view.writable).toHaveLength(WRITABLE_FIELDS.length)
    expect(view.effective.enabled).toBe(true)
    expect(view.learningDraft).toEqual({ model: null })
  })

  test("carries the probe's unacknowledged runtime alerts (AH-D05)", () => {
    const alerts = [{ kind: "runtime-changed" as const, from: "legacy", to: "v2", at: 5 }]
    expect(adaptiveConfigView(viewInput({ alerts })).runtime.alerts).toEqual(alerts)
  })

  test("lists a consent row per registered remote model, then any other provider the config names", () => {
    expect(adaptiveConfigView(viewInput()).egressProviders).toEqual(["jev"])
    const resolved = createAdaptiveConfig({
      read: () => ({ egress: { providers: { other: { enabled: false } } } }),
      env: {},
    }).current()
    const models = [
      { id: "jev", locality: "remote" },
      { id: "small-llm", locality: "remote" },
      { id: "local-embed", locality: "local" },
    ] as const
    expect(adaptiveConfigView(viewInput({ resolved, models })).egressProviders).toEqual(["jev", "small-llm", "other"])
  })

  test("names the model a learning draft is sent to: the learning model first, then small_model", () => {
    expect(adaptiveConfigView(viewInput({ smallModel: () => "openai/gpt-4o-mini" })).learningDraft).toEqual({
      model: "openai/gpt-4o-mini",
    })
    const resolved = createAdaptiveConfig({ read: () => ({ learning: { model: "anthropic/haiku" } }), env: {} }).current()
    expect(
      adaptiveConfigView(viewInput({ resolved, smallModel: () => "openai/gpt-4o-mini" })).learningDraft,
    ).toEqual({ model: "anthropic/haiku" })
  })
})

describe("the surface against a real config file", () => {
  let root = ""
  let config = ""
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flupcode-config-surface-"))
    config = join(root, "config")
    mkdirSync(config, { recursive: true })
    for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME"]) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.OPENCODE_CONFIG_DIR = config
    process.env.XDG_CONFIG_HOME = join(root, "xdg")
    process.env.OPENCODE_TEST_HOME = join(root, "home")
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test("writerTarget picks the file that declares adaptive, then the first that exists, then the default", () => {
    writeFileSync(join(config, "opencode.json"), JSON.stringify({ flupcode: { adaptive: { enabled: true } } }))
    expect(writerTarget()).toEqual({ path: join(config, "opencode.json"), exists: true })

    writeFileSync(join(config, "opencode.json"), JSON.stringify({ theme: "dark" }))
    expect(writerTarget().path).toBe(join(config, "opencode.json"))

    rmSync(join(config, "opencode.json"))
    expect(writerTarget()).toEqual({ path: join(config, "opencode.jsonc"), exists: false })
  })

  test("update writes only the patched leaf and keeps the rest of the file", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(
      path,
      `{
  // keep me
  "theme": "dark",
  "flupcode": { "adaptive": { "enabled": true } }
}
`,
    )
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })

    const result = await service.update({ relevance: { enabled: true } }, false)
    expect(result.warnings).toEqual([])
    expect(result.view.effective.relevance.enabled).toBe(true)

    const after = readFileSync(path, "utf8")
    expect(after).toContain("// keep me")
    const parsed = parse(after, [], { allowTrailingComma: true }) as {
      theme: string
      flupcode: { adaptive: { enabled: boolean; relevance: { enabled: boolean } } }
    }
    expect(parsed.theme).toBe("dark")
    expect(parsed.flupcode.adaptive.relevance.enabled).toBe(true)
    expect(parsed.flupcode.adaptive.enabled).toBe(true)
  })

  test("a nested patch is written as a nested key, never as a dotted literal", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ flupcode: { adaptive: {} } }))
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })

    const result = await service.update({ budget: { monthlyTokens: 5000 } }, false)
    expect(result.view.effective.budget.monthlyTokens).toBe(5000)

    const after = readFileSync(path, "utf8")
    expect(after).not.toContain('"budget.monthlyTokens"')
    const adaptive = (parse(after, [], { allowTrailingComma: true }) as { flupcode: { adaptive: Record<string, unknown> } })
      .flupcode.adaptive
    expect(adaptive.budget).toEqual({ monthlyTokens: 5000 })
    expect(adaptive["budget.monthlyTokens"]).toBeUndefined()
  })

  test("a patch with no leaves neither writes nor creates the file", async () => {
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: () => ({}), env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })

    const result = await service.update({}, false)
    expect(result.warnings).toEqual([])
    expect(existsSync(join(config, "opencode.jsonc"))).toBe(false)
    expect(writerTarget().exists).toBe(false)
  })

  test("an update under a disabled env is refused and changes nothing", async () => {
    const path = join(config, "opencode.json")
    const body = JSON.stringify({ flupcode: { adaptive: { enabled: false } } })
    writeFileSync(path, body)
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: { FLUPCODE_ADAPTIVE_DISABLED: "1" } }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: { FLUPCODE_ADAPTIVE_DISABLED: "1" },
    })

    await expect(service.update({ enabled: true }, false)).rejects.toMatchObject({ code: "env-disabled" })
    expect(readFileSync(path, "utf8")).toBe(body)
  })

  test("read reports the ledger and the writer", () => {
    const view = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: () => ({}), env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: false,
      adaptiveTokenPresent: true,
      env: {},
    }).read()
    expect(view.usage).toMatchObject({ tokensSpent: 0, calls: 0, monthlyTokens: 100_000 })
    expect(view.writer.path).toBe(join(config, "opencode.jsonc"))
    expect(view.canWrite).toBe(false)
  })

  test("deleting a leaf with null restores the default and reports default provenance", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ flupcode: { adaptive: { enabled: false, shadow: false } } }))
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })

    const result = await service.update({ enabled: null, shadow: null }, false)
    expect(result.view.effective.enabled).toBe(true)
    expect(result.view.effective.shadow).toBe(true)
    expect(result.view.source.enabled).toBe("default")
    expect(result.view.source.shadow).toBe("default")
    expect(JSON.parse(readFileSync(path, "utf8")).flupcode.adaptive).toEqual({})
  })

  test("an old config reads the same, and a consent write lands in the new shape without dropping it", async () => {
    const path = join(config, "opencode.jsonc")
    const legacy = { jev: { enabled: true }, egress: { projects: ["/p"], kinds: { completion: true } } }
    writeFileSync(path, JSON.stringify({ flupcode: { adaptive: legacy } }))
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
      models: [{ id: "jev", locality: "remote" }],
    })

    const before = service.read()
    expect(before.effective.egress.providers.jev).toMatchObject({ enabled: true, projects: ["/p"] })
    expect(before.source["egress.providers.jev.enabled"]).toBe("block")
    // Reading never rewrites the file.
    expect(JSON.parse(readFileSync(path, "utf8")).flupcode.adaptive).toEqual(legacy)

    await expect(
      service.update({ egress: { providers: { "small-llm": { enabled: true } } } }, true),
    ).rejects.toMatchObject({ code: "guard:egress-allowlist-required" })
    const small = await service.update(
      { egress: { providers: { "small-llm": { enabled: true, projects: ["/p"], kinds: { skillRelevance: true } } } } },
      true,
    )
    expect(small.view.effective.egress.providers.jev).toEqual(before.effective.egress.providers.jev)
    expect(small.view.egressProviders).toEqual(["jev", "small-llm"])

    const moved = await service.update({ egress: { providers: { jev: { enabled: false } } } }, false)
    expect(moved.view.effective.egress.providers.jev).toMatchObject({ enabled: false, projects: ["/p"] })
    expect(moved.view.effective.egress.providers.jev?.kinds.completion).toBe(true)
    expect(moved.view.effective.egress.providers["small-llm"]?.enabled).toBe(true)
    const written = JSON.parse(readFileSync(path, "utf8")).flupcode.adaptive
    expect(written.egress.providers.jev).toEqual({ enabled: false, projects: ["/p"], kinds: { completion: true } })
    expect(written.jev).toEqual({ enabled: true })
  })

  test("an update keeps comments, nested siblings and unknown keys inside the adaptive block", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(
      path,
      `{
  // keep this profile note
  "flupcode": {
    "adaptive": {
      "decisions": { "completion": { "minConfidence": 0.9 } },
      "relevance": { "enabled": false, "maxSkills": 2 },
      "futureKey": { "keep": true }
    }
  }
}
`,
    )
    const { globalAdaptiveBlock } = await import("../config-files")
    const service = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })

    const result = await service.update({ relevance: { enabled: true } }, false)
    expect(result.view.effective.relevance.enabled).toBe(true)

    const after = readFileSync(path, "utf8")
    expect(after).toContain("// keep this profile note")
    const adaptive = (parse(after, [], { allowTrailingComma: true }) as { flupcode: { adaptive: Record<string, unknown> } })
      .flupcode.adaptive
    expect(adaptive.relevance).toEqual({ enabled: true, maxSkills: 2 })
    expect(adaptive.decisions).toEqual({ completion: { minConfidence: 0.9 } })
    expect(adaptive.futureKey).toEqual({ keep: true })
  })
})
