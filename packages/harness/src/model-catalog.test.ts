import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "./engine-types"
import { hasModel, isDeprecated, replacementModel } from "./model-catalog"

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
})
