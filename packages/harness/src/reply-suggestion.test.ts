import { describe, expect, test } from "bun:test"
import { buildSuggestionPrompt, cleanSuggestion, pickSuggestionModel } from "./reply-suggestion"

describe("cleanSuggestion", () => {
  test("keeps the first line without quotes or a role prefix", () => {
    expect(cleanSuggestion('"Sí, haz el merge"\nextra')).toBe("Sí, haz el merge")
    expect(cleanSuggestion("User: Run the tests")).toBe("Run the tests")
  })
  test("drops empty, NONE and overlong answers", () => {
    expect(cleanSuggestion("")).toBeUndefined()
    expect(cleanSuggestion("NONE")).toBeUndefined()
    expect(cleanSuggestion("x".repeat(201))).toBeUndefined()
  })
})

describe("pickSuggestionModel", () => {
  const models = [
    { providerID: "anthropic", id: "claude-opus-5" },
    { providerID: "anthropic", id: "claude-haiku-4-5" },
    { providerID: "openai", id: "gpt-5-mini" },
  ]
  test("prefers the configured small model", () => {
    expect(pickSuggestionModel({ providerID: "x", id: "y" }, models[0], models)).toEqual({ providerID: "x", id: "y" })
  })
  test("uses a cheap model from the current provider", () => {
    expect(pickSuggestionModel(undefined, models[0], models)).toEqual({
      providerID: "anthropic",
      id: "claude-haiku-4-5",
    })
  })
  test("keeps a current model that is already cheap and never falls back to a large one", () => {
    expect(pickSuggestionModel(undefined, { providerID: "deepseek", id: "deepseek-flash" }, models)?.id).toBe(
      "deepseek-flash",
    )
    expect(pickSuggestionModel(undefined, { providerID: "zai", id: "glm-5" }, models)).toBeUndefined()
  })
})

test("buildSuggestionPrompt keeps the end of long messages", () => {
  const prompt = buildSuggestionPrompt("hola", "a".repeat(5000) + "¿Hago el merge?")
  expect(prompt).toContain("¿Hago el merge?")
  expect(prompt.length).toBeLessThan(3300)
})
