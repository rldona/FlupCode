import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "./engine-types"
import { groupedModels, hasModel, isDeprecated, modelKey, replacementModel } from "./model-catalog"

const model = (id: string, extra: Partial<ModelInfo> = {}) =>
  ({ id, providerID: "opencode-go", name: id, status: "active", time: { released: 0 }, ...extra }) as ModelInfo

const retired = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }

describe("model catalog", () => {
  test("knows which models the engine still serves", () => {
    expect(hasModel([model("deepseek-v4-flash")], retired)).toBe(false)
    expect(hasModel([model("deepseek-v4.1-flash")], retired)).toBe(true)
    // The same id under another provider is another model.
    expect(hasModel([model("deepseek-v4.1-flash", { providerID: "deepseek" })], retired)).toBe(false)
    expect(hasModel([], undefined)).toBe(false)
  })

  test("replaces a retired model with the closest live name from its own provider", () => {
    const replacement = replacementModel(retired, [
      model("deepseek-v4-flash", { time: { released: 10 } }),
      model("deepseek-v4-flash-vision-exp", { time: { released: 20 } }),
      model("deepseek-v4-pro", { time: { released: 30 } }),
      model("gpt-5.6-luna"),
    ])
    expect(replacement?.id).toBe("deepseek-v4-flash")
  })

  test("never suggests a deprecated model or another provider's", () => {
    expect(
      replacementModel(retired, [
        model("deepseek-v4-flash", { status: "deprecated" }),
        model("deepseek-v4-flash", { providerID: "deepseek" }),
      ]),
    ).toBeUndefined()
  })

  test("suggests nothing when no name matches", () => {
    expect(replacementModel(retired, [model("kimi-k3"), model("glm-5.3")])).toBeUndefined()
  })

  test("prefers the newer release between two equally close names", () => {
    const replacement = replacementModel(retired, [
      model("deepseek-v5-flash", { time: { released: 10 } }),
      model("deepseek-v6-flash", { time: { released: 20 } }),
    ])
    expect(replacement?.id).toBe("deepseek-v6-flash")
  })

  test("marks deprecated models as such", () => {
    expect(isDeprecated(model("deepseek-v4-flash", { status: "deprecated" }))).toBe(true)
    expect(isDeprecated(model("deepseek-v4-flash"))).toBe(false)
  })

  test("names a model the way a policy does", () => {
    expect(modelKey(model("deepseek-v4-flash"))).toBe("opencode-go/deepseek-v4-flash")
  })

  test("groups by provider, favourites first and deprecated below the rest", () => {
    const groups = groupedModels(
      [model("zeta"), model("alpha", { status: "deprecated" }), model("beta", { providerID: "anthropic" })],
      "",
      ["opencode-go/zeta"],
    )
    expect(groups.map((group) => group.providerID)).toEqual(["opencode-go", "anthropic"])
    expect(groups[0]!.items.map((entry) => entry.id)).toEqual(["zeta", "alpha"])
    expect(groups[1]!.items.map((entry) => entry.id)).toEqual(["beta"])
  })

  test("filters by name, id or provider", () => {
    const models = [model("kimi-k3"), model("glm-5.3"), model("claude", { providerID: "anthropic" })]
    const ids = (search: string) => groupedModels(models, search, []).flatMap((group) => group.items.map((entry) => entry.id))
    expect(ids("glm")).toEqual(["glm-5.3"])
    expect(ids("anthropic")).toEqual(["claude"])
  })
})
