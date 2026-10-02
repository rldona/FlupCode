import { describe, expect, test } from "bun:test"
import { fallbackModel, modelForTask, parseModelKey } from "./policy"

describe("reading a model key", () => {
  test("provider/model is the two ids the engine wants", () => {
    expect(parseModelKey("anthropic/claude")).toEqual({ providerID: "anthropic", id: "claude" })
  })

  test("only the first slash splits it, so a nested id survives", () => {
    expect(parseModelKey("openrouter/meta/llama")).toEqual({ providerID: "openrouter", id: "meta/llama" })
  })

  test("anything that is not a model is not one", () => {
    for (const value of [undefined, "", "   ", "claude", "/claude", "anthropic/"]) {
      expect(parseModelKey(value)).toBeUndefined()
    }
  })
})

describe("the model a task runs on", () => {
  test("its own wins over the policy", () => {
    const task = { model: { providerID: "a", id: "own" }, agent: "build" }
    expect(modelForTask(task, { models: { build: "a/policy" } })).toEqual({ providerID: "a", id: "own" })
  })

  test("the policy fills the gap for the role it runs as", () => {
    expect(modelForTask({ agent: "plan" }, { models: { plan: "anthropic/claude" } })).toEqual({
      providerID: "anthropic",
      id: "claude",
    })
  })

  test("no policy, or a role it does not name, leaves the engine's default alone", () => {
    expect(modelForTask({ agent: "plan" }, undefined)).toBeUndefined()
    expect(modelForTask({ agent: "plan" }, { models: { build: "a/b" } })).toBeUndefined()
    expect(modelForTask({}, { models: { plan: "a/b" } })).toBeUndefined()
  })
})

describe("the model a retry falls back to", () => {
  test("the policy's fallback, when it names one", () => {
    expect(fallbackModel({ fallback: "a/backup" }, { providerID: "a", id: "primary" })).toEqual({
      providerID: "a",
      id: "backup",
    })
  })

  test("the same model is not asked again", () => {
    const current = { providerID: "a", id: "same" }
    expect(fallbackModel({ fallback: "a/same" }, current)).toEqual(current)
  })

  test("no fallback keeps what there was", () => {
    const current = { providerID: "a", id: "one" }
    expect(fallbackModel(undefined, current)).toEqual(current)
    expect(fallbackModel({}, current)).toEqual(current)
  })
})
