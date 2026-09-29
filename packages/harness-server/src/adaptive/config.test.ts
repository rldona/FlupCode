import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ADAPTIVE_TTL_MS,
  DEFAULT_BUDGET_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_JEV_CONFIG,
  DEFAULT_LEARNING_CONFIG,
  createAdaptiveConfig,
  resolveAdaptiveConfig,
} from "./config"
import { DEFAULT_DECISION_POLICY } from "./decision"
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
  failure: DEFAULT_DECISION_POLICY,
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
      jev: DEFAULT_JEV_CONFIG,
      budget: DEFAULT_BUDGET_CONFIG,
      egress: { enabled: false, projects: [], kinds: allKindsOff() },
      governor: DEFAULT_GOVERNOR_CONFIG,
      context: DEFAULT_CONTEXT_CONFIG,
      learning: DEFAULT_LEARNING_CONFIG,
    })
    expect(config.jev.enabled).toBe(false)
    expect(config.learning.enabled).toBe(false)
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
    expect(config.egress.enabled).toBe(true)
    expect(config.egress.projects).toEqual(["/work/project"])
    expect(config.egress.kinds.completion).toBe(true)
    expect(config.egress.kinds.skillRelevance).toBe(false)
    expect(config.egress.kinds.skillReflection).toBe(false)
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
    expect(config.egress.projects).toEqual(["/p"])
    expect(config.egress.kinds).toEqual(allKindsOff())
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
      block: { learning: { enabled: true, minToolCalls: 20, snapshotKeep: 2, model: "prov/small" } },
      env: {},
    })
    expect(config.learning).toEqual({
      enabled: true,
      minToolCalls: 20,
      snapshotKeep: 2,
      maxInputChars: DEFAULT_LEARNING_CONFIG.maxInputChars,
      maxBodyChars: DEFAULT_LEARNING_CONFIG.maxBodyChars,
      probationSample: DEFAULT_LEARNING_CONFIG.probationSample,
      staleAfter: DEFAULT_LEARNING_CONFIG.staleAfter,
      archiveAfter: DEFAULT_LEARNING_CONFIG.archiveAfter,
      model: "prov/small",
    })

    // A malformed slice falls back to off and the conservative numbers rather than guessing.
    const malformed = resolveAdaptiveConfig({
      block: { learning: { enabled: "yes", minToolCalls: -1, snapshotKeep: "many" } },
      env: {},
    })
    expect(malformed.learning).toEqual(DEFAULT_LEARNING_CONFIG)
  })

  test("composes the Phase 1 resolvers unchanged", () => {
    const block = { runtime: "v2", probe: { ttlMs: 1234 }, episode: { cadenceCalls: 9 } }
    const env = {}
    const config = resolveAdaptiveConfig({ block, env })
    expect(config.runtime).toEqual(resolveRuntimeConfig({ block, env }))
    expect(config.episode).toEqual(resolveEpisodeBoundaryConfig({ block, env }))
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
})
