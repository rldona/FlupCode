import { describe, expect, test } from "bun:test"
import {
  BASELINE_MODEL,
  DEFAULT_ADAPTIVE_TTL_MS,
  DEFAULT_BUDGET_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_JEV_CONFIG,
  DEFAULT_GUARDRAILS_CONFIG,
  DEFAULT_TOOL_TRIM_CONFIG,
  DEFAULT_SELECTION_CONFIG,
  SELECTION_MAX_COLD_GAP_MS,
  SELECTION_MAX_KEEP_RECENT_TURNS,
  TOOL_TRIM_MAX_STORED_BYTES,
  TOOL_TRIM_MIN_THRESHOLD_BYTES,
  TOOL_TRIM_READ_BYTES_CEILING,
  DEFAULT_HOLDOUT_CONFIG,
  DEFAULT_LEARNING_CONFIG,
  LEARNING_LIMIT_CEILINGS,
  DEFAULT_RELEVANCE_CONFIG,
  DEFAULT_RETENTION_CONFIG,
  DEFAULT_VOI_CONFIG,
  DEFAULT_VOI_KIND_CONFIG,
  RELEVANCE_MAX_SKILLS_CEILING,
  RELEVANCE_TIMEOUT_MS_CEILING,
  createAdaptiveConfig,
  resolveAdaptiveConfig,
} from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionKind, DecisionPolicy } from "./decision"
import { DEFAULT_EPISODE_BOUNDARY_CONFIG, resolveEpisodeBoundaryConfig } from "./episode"
import { DEFAULT_GOVERNOR_CONFIG } from "./providers/governor"
import { DEFAULT_RUNTIME_PROBE_CONFIG, resolveRuntimeConfig } from "./runtime-config"

const allPolicies = (): Record<DecisionKind, DecisionPolicy> => ({
  completion: DEFAULT_DECISION_POLICY,
  skillRelevance: DEFAULT_DECISION_POLICY,
  contextItem: {
    ...DEFAULT_DECISION_POLICY,
    keepThreshold: DEFAULT_CONTEXT_CONFIG.keepThreshold,
    dropThreshold: DEFAULT_CONTEXT_CONFIG.dropThreshold,
  },
  modelRoute: DEFAULT_DECISION_POLICY,
  agentRoute: DEFAULT_DECISION_POLICY,
  toolRisk: DEFAULT_DECISION_POLICY,
  failure: {
    ...DEFAULT_DECISION_POLICY,
    repeatedCalls: DEFAULT_GUARDRAILS_CONFIG.repeatedCalls,
    repeatedErrors: DEFAULT_GUARDRAILS_CONFIG.repeatedErrors,
  },
  skillReflection: DEFAULT_DECISION_POLICY,
})

const allKindsOff = (): Record<DecisionKind, boolean> => ({
  completion: false,
  skillRelevance: false,
  contextItem: false,
  modelRoute: false,
  agentRoute: false,
  toolRisk: false,
  failure: false,
  skillReflection: false,
})

describe("resolveAdaptiveConfig", () => {
  test("falls back to defaults with nothing set, Jev off", () => {
    const config = resolveAdaptiveConfig({ env: {} })
    expect(config).toEqual({
      enabled: true,
      shadow: true,
      runtime: DEFAULT_RUNTIME_PROBE_CONFIG,
      episode: DEFAULT_EPISODE_BOUNDARY_CONFIG,
      decisions: allPolicies(),
      models: {},
      jev: DEFAULT_JEV_CONFIG,
      budget: DEFAULT_BUDGET_CONFIG,
      egress: { providers: { jev: { enabled: false, projects: [], kinds: allKindsOff() } } },
      governor: DEFAULT_GOVERNOR_CONFIG,
      context: DEFAULT_CONTEXT_CONFIG,
      learning: DEFAULT_LEARNING_CONFIG,
      relevance: DEFAULT_RELEVANCE_CONFIG,
      retention: DEFAULT_RETENTION_CONFIG,
      guardrails: DEFAULT_GUARDRAILS_CONFIG,
      toolTrim: DEFAULT_TOOL_TRIM_CONFIG,
      holdout: DEFAULT_HOLDOUT_CONFIG,
      voi: {
        ...DEFAULT_VOI_CONFIG,
        kinds: Object.fromEntries(decisionKinds().map((kind) => [kind, DEFAULT_VOI_KIND_CONFIG])) as Record<
          DecisionKind,
          typeof DEFAULT_VOI_KIND_CONFIG
        >,
      },
      compaction: DEFAULT_COMPACTION_CONFIG,
      selection: DEFAULT_SELECTION_CONFIG,
    })
    expect(config.jev.enabled).toBe(false)
    expect(config.learning.enabled).toBe(false)
    expect(config.relevance.enabled).toBe(false)
    expect(config.retention.enabled).toBe(false)
    expect(config.guardrails.enabled).toBe(false)
  })

  test("reads the flupcode.adaptive block", () => {
    const config = resolveAdaptiveConfig({
      block: {
        enabled: false,
        shadow: false,
        jev: { enabled: true, model: "jev-x", timeoutMs: 900, maxInputTokens: 1000 },
        budget: { monthlyTokens: 5000, hotReserveFraction: 0.5 },
        egress: { projects: ["/work/project"], kinds: { completion: true, nope: true } },
        decisions: { completion: { minConfidence: 0.9, allowJev: false } },
      },
      env: {},
    })
    expect(config.enabled).toBe(false)
    expect(config.shadow).toBe(false)
    expect(config.jev).toEqual({
      enabled: true,
      endpoint: DEFAULT_JEV_CONFIG.endpoint,
      model: "jev-x",
      timeoutMs: 900,
      maxInputTokens: 1000,
    })
    expect(config.budget).toEqual({ monthlyTokens: 5000, hotReserveFraction: 0.5 })
    expect(config.governor.monthlyTokenBudget).toBe(5000)
    expect(config.governor.hotReserveFraction).toBe(0.5)
    expect(config.governor.breakerFailures).toBe(DEFAULT_GOVERNOR_CONFIG.breakerFailures)
    expect(config.egress.providers.jev?.enabled).toBe(true)
    expect(config.egress.providers.jev?.projects).toEqual(["/work/project"])
    expect(config.egress.providers.jev?.kinds.completion).toBe(true)
    expect(config.egress.providers.jev?.kinds.skillRelevance).toBe(false)
    expect(config.egress.providers.jev?.kinds.skillReflection).toBe(false)
    expect(config.decisions.completion).toEqual({ allowJev: false, minConfidence: 0.9, minProbability: 0.5, timeoutMs: 400 })
    expect(config.decisions.skillRelevance).toEqual(DEFAULT_DECISION_POLICY)
  })

  test("the environment wins over the block, which wins over the default", () => {
    const config = resolveAdaptiveConfig({
      block: { enabled: true, runtime: "legacy", episode: { cadenceCalls: 9 } },
      env: {
        FLUPCODE_ADAPTIVE_DISABLED: "1",
        FLUPCODE_ADAPTIVE_RUNTIME: "off",
        FLUPCODE_ADAPTIVE_EPISODE_CADENCE_CALLS: "3",
      },
    })
    expect(config.enabled).toBe(false)
    expect(config.runtime.override).toBe("off")
    expect(config.episode.cadenceCalls).toBe(3)
  })

  test("the kill switch does not touch episodes", () => {
    const config = resolveAdaptiveConfig({ block: { enabled: false, episode: { cadenceCalls: 7 } }, env: {} })
    expect(config.enabled).toBe(false)
    expect(config.episode.cadenceCalls).toBe(7)
  })

  test("ignores malformed values rather than guessing", () => {
    const config = resolveAdaptiveConfig({
      block: {
        enabled: "no",
        shadow: "no",
        jev: { enabled: "yes" },
        budget: { monthlyTokens: -1, hotReserveFraction: 2 },
        egress: { projects: ["/p", 7], kinds: [] },
        decisions: { completion: { minConfidence: 2, allowJev: "yes", timeoutMs: -1 } },
      },
      env: {},
    })
    expect(config.enabled).toBe(true)
    expect(config.shadow).toBe(true)
    expect(config.jev).toEqual(DEFAULT_JEV_CONFIG)
    expect(config.budget).toEqual(DEFAULT_BUDGET_CONFIG)
    expect(config.egress.providers.jev?.projects).toEqual(["/p"])
    expect(config.egress.providers.jev?.kinds).toEqual(allKindsOff())
    expect(config.decisions.completion).toEqual(DEFAULT_DECISION_POLICY)
  })

  test("the context slice defaults to shadow planning and reads its block", () => {
    const defaults = resolveAdaptiveConfig({ env: {} }).context
    expect(defaults.enabled).toBe(true)
    expect(defaults.apply).toBe(false)
    expect(defaults.budget).toEqual(DEFAULT_CONTEXT_CONFIG.budget)

    const config = resolveAdaptiveConfig({
      block: {
        context: {
          enabled: false,
          apply: true,
          keepThreshold: 0.8,
          dropThreshold: 0.1,
          budget: { total: 100, perClass: { file: 40 } },
        },
      },
      env: {},
    })
    expect(config.context.enabled).toBe(false)
    expect(config.context.apply).toBe(true)
    expect(config.context.keepThreshold).toBe(0.8)
    expect(config.context.dropThreshold).toBe(0.1)
    expect(config.context.budget.total).toBe(100)
    expect(config.context.budget.perClass.file).toBe(40)
    // A kind the block does not mention keeps its own default.
    expect(config.context.budget.perClass.error).toBe(DEFAULT_CONTEXT_CONFIG.budget.perClass.error)

    // A malformed context block is ignored rather than guessed.
    const malformed = resolveAdaptiveConfig({
      block: { context: { enabled: "no", apply: "yes", keepThreshold: 2, budget: { total: -1 } } },
      env: {},
    })
    expect(malformed.context).toEqual(DEFAULT_CONTEXT_CONFIG)
  })

  test("the learning slice is off by default and reads its block", () => {
    const defaults = resolveAdaptiveConfig({ env: {} }).learning
    expect(defaults).toEqual(DEFAULT_LEARNING_CONFIG)
    expect(defaults.enabled).toBe(false)

    const config = resolveAdaptiveConfig({
      block: { learning: { enabled: true, minToolCalls: 20, snapshotKeep: 2, draftTimeoutMs: 30_000, model: "prov/small" } },
      env: {},
    })
    expect(config.learning).toEqual({
      enabled: true,
      minToolCalls: 20,
      snapshotKeep: 2,
      maxInputChars: DEFAULT_LEARNING_CONFIG.maxInputChars,
      maxBodyChars: DEFAULT_LEARNING_CONFIG.maxBodyChars,
      draftTimeoutMs: 30_000,
      archiveAfter: DEFAULT_LEARNING_CONFIG.archiveAfter,
      model: "prov/small",
      frozen: false,
      limits: DEFAULT_LEARNING_CONFIG.limits,
    })

    // A malformed slice falls back to off and the conservative numbers rather than guessing.
    const malformed = resolveAdaptiveConfig({
      block: { learning: { enabled: "yes", minToolCalls: -1, snapshotKeep: "many", draftTimeoutMs: 0 } },
      env: {},
    })
    expect(malformed.learning).toEqual(DEFAULT_LEARNING_CONFIG)
  })

  test("the learning freeze and caps (AH-F03) default safe, read their block and clamp", () => {
    const defaults = resolveAdaptiveConfig({ env: {} }).learning
    expect(defaults.frozen).toBe(false)
    expect(defaults.limits).toEqual({ proposalsPerDay: 5, maxLearnedSkills: 20, patchesPerWeek: 5 })

    const configured = resolveAdaptiveConfig({
      block: { learning: { frozen: true, limits: { proposalsPerDay: 2, maxLearnedSkills: 7.9, patchesPerWeek: 3 } } },
      env: {},
    }).learning
    expect(configured.frozen).toBe(true)
    expect(configured.limits).toEqual({ proposalsPerDay: 2, maxLearnedSkills: 7, patchesPerWeek: 3 })

    // Past its ceiling a cap is clamped, never lifted; a typo cannot turn a cap into no cap.
    const huge = resolveAdaptiveConfig({
      block: { learning: { limits: { proposalsPerDay: 1e9, maxLearnedSkills: 1e9, patchesPerWeek: 1e9 } } },
      env: {},
    }).learning
    expect(huge.limits).toEqual(LEARNING_LIMIT_CEILINGS)

    // Zero, a fraction below one, a negative, a string or a non-object block fall back to the default.
    const malformed = resolveAdaptiveConfig({
      block: { learning: { frozen: "yes", limits: { proposalsPerDay: 0, maxLearnedSkills: 0.5, patchesPerWeek: "9" } } },
      env: {},
    }).learning
    expect(malformed.frozen).toBe(false)
    expect(malformed.limits).toEqual(DEFAULT_LEARNING_CONFIG.limits)
    expect(resolveAdaptiveConfig({ block: { learning: { limits: [3] } }, env: {} }).learning.limits).toEqual(
      DEFAULT_LEARNING_CONFIG.limits,
    )
  })

  test("the relevance slice is off by default and reads its block", () => {
    const defaults = resolveAdaptiveConfig({ env: {} }).relevance
    expect(defaults).toEqual(DEFAULT_RELEVANCE_CONFIG)
    expect(defaults.enabled).toBe(false)

    const config = resolveAdaptiveConfig({
      block: { relevance: { enabled: true, maxSkills: 2, rosterTtlMs: 1000, timeoutMs: 250 } },
      env: {},
    })
    expect(config.relevance).toEqual({ enabled: true, maxSkills: 2, rosterTtlMs: 1000, timeoutMs: 250 })

    // The ceiling keeps the writer in step with the plugin, which only accepts a box of up to three
    // names; a larger value would render a line the plugin drops.
    const capped = resolveAdaptiveConfig({
      block: { relevance: { enabled: true, maxSkills: 5 } },
      env: {},
    })
    expect(capped.relevance.maxSkills).toBe(RELEVANCE_MAX_SKILLS_CEILING)

    // A malformed value is ignored rather than guessed.
    const malformed = resolveAdaptiveConfig({
      block: { relevance: { enabled: "yes", maxSkills: -1, rosterTtlMs: "many" } },
      env: {},
    })
    expect(malformed.relevance).toEqual(DEFAULT_RELEVANCE_CONFIG)
  })

  test("clamps the relevance deadline below the plugin's fetch timeout", () => {
    // The plugin bounds its own fetch at 500 ms by default, so the server's deadline must stay under
    // `RELEVANCE_TIMEOUT_MS_CEILING` or the line would vanish without the server ever answering.
    expect(RELEVANCE_TIMEOUT_MS_CEILING).toBeLessThan(500)
    const clamped = resolveAdaptiveConfig({
      block: { relevance: { enabled: true, timeoutMs: 10_000 } },
      env: {},
    })
    expect(clamped.relevance.timeoutMs).toBe(RELEVANCE_TIMEOUT_MS_CEILING)
  })

  test("the retention slice is off by default and reads its block", () => {
    const defaults = resolveAdaptiveConfig({ env: {} }).retention
    expect(defaults).toEqual(DEFAULT_RETENTION_CONFIG)
    expect(defaults.enabled).toBe(false)

    const config = resolveAdaptiveConfig({
      block: { retention: { enabled: true, decisionsDays: 7, actingDays: 120, rejectedProposalsDays: 14 } },
      env: {},
    })
    expect(config.retention).toEqual({
      enabled: true,
      decisionsDays: 7,
      actingDays: 120,
      plansDays: DEFAULT_RETENTION_CONFIG.plansDays,
      appliedPlansDays: DEFAULT_RETENTION_CONFIG.appliedPlansDays,
      reflectionDays: DEFAULT_RETENTION_CONFIG.reflectionDays,
      rejectedProposalsDays: 14,
    })

    // A malformed window is ignored rather than guessed, and `enabled` is explicit.
    const malformed = resolveAdaptiveConfig({
      block: { retention: { enabled: "yes", decisionsDays: -1, actingDays: "many" } },
      env: {},
    })
    expect(malformed.retention).toEqual(DEFAULT_RETENTION_CONFIG)
  })

  test("the guardrails slice is off by default, reads its block and feeds the failure policy", () => {
    const defaults = resolveAdaptiveConfig({ env: {} })
    expect(defaults.guardrails).toEqual(DEFAULT_GUARDRAILS_CONFIG)
    expect(defaults.guardrails.enabled).toBe(false)
    // The failure policy carries the detector thresholds, so baseline and audit agree on them.
    expect(defaults.decisions.failure.repeatedCalls).toBe(DEFAULT_GUARDRAILS_CONFIG.repeatedCalls)
    expect(defaults.decisions.failure.repeatedErrors).toBe(DEFAULT_GUARDRAILS_CONFIG.repeatedErrors)

    const config = resolveAdaptiveConfig({
      block: {
        guardrails: { enabled: true, repeatedCalls: 5, repeatedErrors: 2, windowMs: 1000, maxObservations: 10, maxSessions: 3, timeoutMs: 250 },
      },
      env: {},
    })
    expect(config.guardrails).toEqual({
      enabled: true,
      repeatedCalls: 5,
      repeatedErrors: 2,
      windowMs: 1000,
      maxObservations: 10,
      maxSessions: 3,
      timeoutMs: 250,
    })
    expect(config.decisions.failure.repeatedCalls).toBe(5)
    expect(config.decisions.failure.repeatedErrors).toBe(2)

    // A malformed value is ignored rather than guessed, and `enabled` is explicit.
    const malformed = resolveAdaptiveConfig({
      block: { guardrails: { enabled: "yes", repeatedCalls: -1, windowMs: "many" } },
      env: {},
    })
    expect(malformed.guardrails).toEqual(DEFAULT_GUARDRAILS_CONFIG)
  })

  test("the selection slice is off by default, with a gap past every cache TTL, inside the plugin's bounds", () => {
    const defaults = resolveAdaptiveConfig({ env: {} })
    expect(defaults.selection).toEqual({ enabled: false, keepRecentTurns: 2, minSavingsTokens: 4_096, coldGapMs: 3_900_000 })

    const config = resolveAdaptiveConfig({
      block: { selection: { enabled: true, keepRecentTurns: 0, minSavingsTokens: 0, coldGapMs: 360_000 } },
      env: {},
    })
    expect(config.selection).toEqual({ enabled: true, keepRecentTurns: 0, minSavingsTokens: 0, coldGapMs: 360_000 })

    const clamped = resolveAdaptiveConfig({
      block: { selection: { keepRecentTurns: 1_000, coldGapMs: 1e12 } },
      env: {},
    })
    expect(clamped.selection.keepRecentTurns).toBe(SELECTION_MAX_KEEP_RECENT_TURNS)
    expect(clamped.selection.coldGapMs).toBe(SELECTION_MAX_COLD_GAP_MS)

    const malformed = resolveAdaptiveConfig({
      block: { selection: { enabled: "yes", keepRecentTurns: -1, minSavingsTokens: 1.5, coldGapMs: 0 } },
      env: {},
    })
    expect(malformed.selection).toEqual(DEFAULT_SELECTION_CONFIG)
  })

  test("the tool-trim slice is off by default and keeps its numbers inside the plugin's bounds", () => {
    const defaults = resolveAdaptiveConfig({ env: {} })
    expect(defaults.toolTrim).toEqual(DEFAULT_TOOL_TRIM_CONFIG)
    expect(defaults.toolTrim.enabled).toBe(false)

    const config = resolveAdaptiveConfig({
      block: {
        toolTrim: {
          enabled: true,
          thresholdBytes: 16_384,
          headBytes: 1_000,
          tailBytes: 500,
          maxStoredBytes: 1_000_000,
          readBytes: 8_192,
          exempt: ["bash"],
        },
      },
      env: {},
    })
    expect(config.toolTrim).toEqual({
      enabled: true,
      thresholdBytes: 16_384,
      headBytes: 1_000,
      tailBytes: 500,
      maxStoredBytes: 1_000_000,
      readBytes: 8_192,
      exempt: ["bash"],
    })

    // Out-of-bounds numbers are clamped to what the plugin and the engine can honour, and an empty
    // exempt list is an explicit "exempt nothing", not a fallback to the default.
    const clamped = resolveAdaptiveConfig({
      block: {
        toolTrim: { thresholdBytes: 10, headBytes: 1_000_000, maxStoredBytes: 1e12, readBytes: 1e9, exempt: [] },
      },
      env: {},
    })
    expect(clamped.toolTrim.thresholdBytes).toBe(TOOL_TRIM_MIN_THRESHOLD_BYTES)
    expect(clamped.toolTrim.headBytes).toBe(TOOL_TRIM_MIN_THRESHOLD_BYTES / 4)
    expect(clamped.toolTrim.maxStoredBytes).toBe(TOOL_TRIM_MAX_STORED_BYTES)
    expect(clamped.toolTrim.readBytes).toBe(TOOL_TRIM_READ_BYTES_CEILING)
    expect(clamped.toolTrim.exempt).toEqual([])

    const malformed = resolveAdaptiveConfig({
      block: { toolTrim: { enabled: "yes", thresholdBytes: -1, headBytes: 1.5, exempt: "read" } },
      env: {},
    })
    expect(malformed.toolTrim).toEqual(DEFAULT_TOOL_TRIM_CONFIG)
  })

  test("composes the Phase 1 resolvers unchanged", () => {
    const block = { runtime: "v2", probe: { ttlMs: 1234 }, episode: { cadenceCalls: 9 } }
    const env = {}
    const config = resolveAdaptiveConfig({ block, env })
    expect(config.runtime).toEqual(resolveRuntimeConfig({ block, env }))
    expect(config.episode).toEqual(resolveEpisodeBoundaryConfig({ block, env }))
  })
})

describe("the model per kind (AH-C01)", () => {
  const everyKind = (id: string) => Object.fromEntries(decisionKinds().map((kind) => [kind, id]))

  test("without a models block, every kind asks Jev only when Jev is enabled", () => {
    expect(resolveAdaptiveConfig({ block: {}, env: {} }).models).toEqual({})
    expect(resolveAdaptiveConfig({ block: { jev: { enabled: false } }, env: {} }).models).toEqual({})
    expect(resolveAdaptiveConfig({ block: { jev: { enabled: true } }, env: {} }).models).toEqual(everyKind("jev"))
  })

  test("a named kind takes its model; the kinds it does not name keep the legacy assignment", () => {
    const withJev = resolveAdaptiveConfig({
      block: { jev: { enabled: true }, models: { skillRelevance: "small-llm" } },
      env: {},
    })
    expect(withJev.models).toEqual({ ...everyKind("jev"), skillRelevance: "small-llm" })

    const withoutJev = resolveAdaptiveConfig({ block: { models: { skillRelevance: "small-llm" } }, env: {} })
    expect(withoutJev.models).toEqual({ skillRelevance: "small-llm" })
  })

  test("`baseline` pins a kind to the deterministic answer even with Jev on", () => {
    const config = resolveAdaptiveConfig({
      block: { jev: { enabled: true }, models: { completion: BASELINE_MODEL } },
      env: {},
    })
    expect(config.models.completion).toBeUndefined()
    expect(config.models.failure).toBe("jev")
  })

  test("a malformed block or entry is ignored rather than guessed", () => {
    expect(resolveAdaptiveConfig({ block: { models: "jev" }, env: {} }).models).toEqual({})
    const config = resolveAdaptiveConfig({
      block: { jev: { enabled: true }, models: { completion: 42, failure: "  ", unknownKind: "x" } },
      env: {},
    })
    expect(config.models).toEqual(everyKind("jev"))
  })
})

describe("egress consent per provider (AH-C03)", () => {
  const kindsOn = (...on: DecisionKind[]) => ({ ...allKindsOff(), ...Object.fromEntries(on.map((kind) => [kind, true])) })

  test("an old config reads as Jev's consent alone, exactly as before", () => {
    const config = resolveAdaptiveConfig({
      block: {
        jev: { enabled: true },
        egress: { enabled: false, projects: ["/p"], kinds: { completion: true, skillReflection: true } },
      },
      env: {},
    })
    // `egress.enabled` was never read: `jev.enabled` was the switch, and still is for an old file.
    expect(config.egress).toEqual({
      providers: { jev: { enabled: true, projects: ["/p"], kinds: kindsOn("completion", "skillReflection") } },
    })
    expect(config.models).toMatchObject({ completion: "jev", skillReflection: "jev" })

    const off = resolveAdaptiveConfig({ block: { egress: { projects: ["/p"], kinds: { completion: true } } }, env: {} })
    expect(off.egress.providers.jev).toEqual({ enabled: false, projects: ["/p"], kinds: kindsOn("completion") })
  })

  test("the new shape keeps each provider's consent apart", () => {
    const config = resolveAdaptiveConfig({
      block: {
        egress: {
          providers: {
            "small-llm": { enabled: true, projects: ["/p"], kinds: { skillRelevance: true } },
            jev: { enabled: false, projects: ["/q"], kinds: { completion: true } },
          },
        },
      },
      env: {},
    })
    expect(config.egress.providers).toEqual({
      jev: { enabled: false, projects: ["/q"], kinds: kindsOn("completion") },
      "small-llm": { enabled: true, projects: ["/p"], kinds: kindsOn("skillRelevance") },
    })
    // Consenting to a provider assigns no model: Jev is not asked for anything.
    expect(config.models).toEqual({})
  })

  test("once providers.jev exists the legacy keys grant Jev nothing; jev.enabled only assigns it", () => {
    const config = resolveAdaptiveConfig({
      block: {
        jev: { enabled: true },
        egress: { projects: ["/p"], kinds: { completion: true }, providers: { jev: { projects: ["/p"] } } },
      },
      env: {},
    })
    expect(config.egress.providers.jev).toEqual({ enabled: false, projects: ["/p"], kinds: allKindsOff() })
    expect(config.models.completion).toBe("jev")
  })

  test("a mixed config reads Jev from the legacy keys and every other provider from its entry", () => {
    const config = resolveAdaptiveConfig({
      block: {
        jev: { enabled: true },
        egress: {
          projects: ["/p"],
          kinds: { completion: true },
          providers: { "small-llm": { enabled: true, projects: ["/other"], kinds: { skillRelevance: true } } },
        },
      },
      env: {},
    })
    expect(config.egress.providers.jev).toEqual({ enabled: true, projects: ["/p"], kinds: kindsOn("completion") })
    expect(config.egress.providers["small-llm"]).toEqual({
      enabled: true,
      projects: ["/other"],
      kinds: kindsOn("skillRelevance"),
    })
  })

  test("a malformed provider entry or id is ignored rather than guessed", () => {
    const config = resolveAdaptiveConfig({
      block: {
        egress: {
          providers: {
            "bad id": { enabled: true, projects: ["/p"], kinds: { completion: true } },
            "small-llm": "yes",
            local: { enabled: "yes", projects: ["/p", 3], kinds: { completion: 1, nope: true } },
          },
        },
      },
      env: {},
    })
    expect(Object.keys(config.egress.providers).sort()).toEqual(["jev", "local"])
    expect(config.egress.providers.local).toEqual({ enabled: false, projects: ["/p"], kinds: allKindsOff() })
  })
})

describe("createAdaptiveConfig", () => {
  test("re-reads the block after the TTL, so the kill switch needs no restart", () => {
    let block: Record<string, unknown> = { enabled: true }
    let clock = 0
    const adaptive = createAdaptiveConfig({ read: () => block, env: {}, ttlMs: 100, now: () => clock })

    expect(adaptive.current().enabled).toBe(true)

    // Within the TTL the composed config is trusted, even though the block changed.
    block = { enabled: false }
    expect(adaptive.current().enabled).toBe(true)

    clock = 100
    expect(adaptive.current().enabled).toBe(false)
  })

  test("has a default TTL shorter than the runtime probe", () => {
    expect(DEFAULT_ADAPTIVE_TTL_MS).toBeLessThan(DEFAULT_RUNTIME_PROBE_CONFIG.ttlMs)
  })

  test("exposes the raw block and invalidate() forces a re-read inside the TTL", () => {
    let block: Record<string, unknown> = { enabled: true, shadow: true }
    let clock = 0
    const adaptive = createAdaptiveConfig({ read: () => block, env: {}, ttlMs: 100, now: () => clock })

    expect(adaptive.current().enabled).toBe(true)
    expect(adaptive.raw()).toEqual({ enabled: true, shadow: true })

    // Within the TTL the cache holds, even though the block changed.
    block = { enabled: false }
    expect(adaptive.current().enabled).toBe(true)

    // invalidate() drops the cache, so the very next read sees the new bytes.
    adaptive.invalidate()
    expect(adaptive.raw()).toEqual({ enabled: false })
    expect(adaptive.current().enabled).toBe(false)
  })
})

describe("the value-of-information gate config (AH-C05)", () => {
  test("is on by default with the audit's window, warm-up, epsilon and 5% exploration", () => {
    const voi = resolveAdaptiveConfig({ env: {} }).voi
    expect(voi).toMatchObject({ enabled: true, window: 200, minSamples: 30, epsilon: 0.02, explorationRate: 0.05 })
    expect(voi.kinds.skillRelevance).toEqual(DEFAULT_VOI_KIND_CONFIG)
  })

  test("reads the global numbers and lets a kind override the value, latency cost and cache TTL", () => {
    const voi = resolveAdaptiveConfig({
      env: {},
      block: {
        voi: {
          enabled: false,
          window: 100,
          minSamples: 10,
          epsilon: 0.1,
          explorationRate: 0.2,
          valueOfCorrect: 0.5,
          latencyCostUsdPerSecond: 0.01,
          cacheTtlMs: 5_000,
          kinds: { completion: { valueOfCorrect: 2, cacheTtlMs: 0 } },
        },
      },
    }).voi
    expect(voi).toMatchObject({ enabled: false, window: 100, minSamples: 10, epsilon: 0.1, explorationRate: 0.2 })
    expect(voi.kinds.completion).toEqual({ valueOfCorrect: 2, latencyCostUsdPerSecond: 0.01, cacheTtlMs: 0 })
    expect(voi.kinds.skillRelevance).toEqual({ valueOfCorrect: 0.5, latencyCostUsdPerSecond: 0.01, cacheTtlMs: 5_000 })
  })

  test("ignores malformed values rather than guessing", () => {
    const voi = resolveAdaptiveConfig({
      env: {},
      block: {
        voi: {
          enabled: "yes",
          window: 2.5,
          minSamples: -1,
          epsilon: 3,
          explorationRate: -0.1,
          valueOfCorrect: -1,
          kinds: { completion: "fast", failure: { cacheTtlMs: "long" } },
        },
      },
    }).voi
    expect(voi).toMatchObject(DEFAULT_VOI_CONFIG)
    expect(voi.kinds.completion).toEqual(DEFAULT_VOI_KIND_CONFIG)
    expect(voi.kinds.failure).toEqual(DEFAULT_VOI_KIND_CONFIG)
  })
})

describe("compaction slice", () => {
  test("anchors are on unless the block says false", () => {
    expect(resolveAdaptiveConfig({ env: {} }).compaction.anchors).toBe(true)
    expect(resolveAdaptiveConfig({ block: { compaction: { anchors: false } }, env: {} }).compaction.anchors).toBe(false)
    expect(resolveAdaptiveConfig({ block: { compaction: { anchors: "no" } }, env: {} }).compaction.anchors).toBe(true)
  })
})
