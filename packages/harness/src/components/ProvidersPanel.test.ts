import { describe, expect, test } from "bun:test"
import type { ProviderAuthMethod } from "../engine-types"
import { defaultInputs, matchesPrompt } from "./ProvidersPanel"

const select = (
  key: string,
  options: string[],
  when?: { key: string; op: "eq" | "neq"; value: string },
): NonNullable<ProviderAuthMethod["prompts"]>[number] => ({
  type: "select",
  key,
  message: key,
  options: options.map((value) => ({ label: value, value })),
  ...(when && { when }),
})

const text = (
  key: string,
  when?: { key: string; op: "eq" | "neq"; value: string },
): NonNullable<ProviderAuthMethod["prompts"]>[number] => ({
  type: "text",
  key,
  message: key,
  ...(when && { when }),
})

describe("which legacy prompt is shown", () => {
  test("an unconditional prompt always shows", () => {
    expect(matchesPrompt(select("deploymentType", ["github.com", "enterprise"]), {})).toBe(true)
  })

  test("eq shows only when the answer matches", () => {
    const prompt = text("enterpriseUrl", { key: "deploymentType", op: "eq", value: "enterprise" })
    expect(matchesPrompt(prompt, { deploymentType: "github.com" })).toBe(false)
    expect(matchesPrompt(prompt, { deploymentType: "enterprise" })).toBe(true)
  })

  test("neq matches the TUI when the key has not been answered yet", () => {
    // The TUI compares directly (`undefined !== "x"`), so an unanswered key still shows the prompt.
    const prompt = text("other", { key: "mode", op: "neq", value: "x" })
    expect(matchesPrompt(prompt, {})).toBe(true)
    expect(matchesPrompt(prompt, { mode: "x" })).toBe(false)
    expect(matchesPrompt(prompt, { mode: "y" })).toBe(true)
  })
})

describe("default answers for a legacy method", () => {
  test("a select starts on its first option", () => {
    const method: ProviderAuthMethod = {
      type: "oauth",
      label: "Sign in",
      prompts: [select("deploymentType", ["github.com", "enterprise"])],
    }
    expect(defaultInputs(method)).toEqual({ deploymentType: "github.com" })
  })

  test("a text prompt is left empty and a method without prompts has no answers", () => {
    expect(defaultInputs({ type: "oauth", label: "Sign in", prompts: [text("url")] })).toEqual({})
    expect(defaultInputs({ type: "oauth", label: "Sign in" })).toEqual({})
  })
})
