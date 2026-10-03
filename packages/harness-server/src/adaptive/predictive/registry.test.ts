import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import { DECISIONS } from "../decisions/registry"
import { createAdaptiveEgressGuard } from "../egress"
import { canAnswer } from "./model"
import { createPredictiveProviders } from "./registry"
import type { ProviderDeps } from "./registry"

const deps = (smallModel: ProviderDeps["smallModel"]): ProviderDeps => {
  const config = resolveAdaptiveConfig({ block: {}, env: {} })
  return {
    egress: createAdaptiveEgressGuard({ config: () => config }),
    providers: () => config.providers,
    keys: { resolve: async () => undefined },
    smallModel,
    // The engine is only reached when small-llm predicts, which no test here does.
    engine: () => ({}) as never,
  }
}

describe("the provider registry (PI-02)", () => {
  test("builds the HTTP model always and small-llm only with a small_model", () => {
    expect(createPredictiveProviders(deps(() => undefined)).map((model) => model.id)).toEqual(["jev"])
    const withSmall = createPredictiveProviders(deps(() => ({ providerID: "anthropic", id: "claude-haiku-4-5" })))
    expect(withSmall.map((model) => model.id)).toEqual(["jev", "small-llm"])
  })

  test("each provider declares its capabilities and latency class", () => {
    const models = createPredictiveProviders(deps(() => ({ providerID: "anthropic", id: "claude-haiku-4-5" })))
    expect(models.map((model) => [model.id, model.capabilities, model.latencyClass])).toEqual([
      ["jev", ["classify"], "hot"],
      ["small-llm", ["classify"], "warm"],
    ])
  })
})

describe("canAnswer", () => {
  const completion = DECISIONS.get("completion")
  const failure = DECISIONS.get("failure")

  test("a model without declarations is a hot classifier for every kind", () => {
    expect(DECISIONS.kinds.filter((kind) => canAnswer({}, DECISIONS.get(kind)))).toEqual([...DECISIONS.kinds])
  })

  test("the kind's capability must be one the model declares", () => {
    expect(canAnswer({ capabilities: ["rank"] }, completion)).toBe(false)
    expect(canAnswer({ capabilities: ["rank", "classify"] }, completion)).toBe(true)
  })

  test("a batch model is never asked a hot kind; a warm one may be", () => {
    expect(failure.latencyClass).toBe("hot")
    expect(canAnswer({ latencyClass: "batch" }, failure)).toBe(false)
    expect(canAnswer({ latencyClass: "warm" }, failure)).toBe(true)
    expect(canAnswer({ latencyClass: "batch" }, completion)).toBe(true)
  })

  test("a model that lists its kinds answers only those", () => {
    expect(canAnswer({ supports: ["failure"] }, completion)).toBe(false)
    expect(canAnswer({ supports: ["failure"] }, failure)).toBe(true)
  })
})
