import { describe, expect, test } from "bun:test"
import { actionInputProblem, allowRulesFrom, missingAllowRules, requiredAllowRules } from "./action-allow"
import type { ActionProfile } from "./actions"

const profile = (overrides: Partial<ActionProfile> = {}): ActionProfile => ({
  id: "publish",
  tool: "do_publish",
  description: "Publish the piece",
  kind: "browser",
  origin: "https://example.com",
  inputs: {},
  steps: [],
  guards: [],
  sensitive: false,
  availability: "host",
  evidence: {},
  ...overrides,
})

describe("the allow rules an action needs (WA-7)", () => {
  test("a read action needs the origin; one with effects needs origin:action", () => {
    expect(requiredAllowRules(profile())).toEqual([
      { permission: "browser", pattern: "https://example.com", action: "allow" },
    ])
    expect(requiredAllowRules(profile({ sensitive: true }))).toEqual([
      { permission: "browser_sensitive", pattern: "https://example.com:publish", action: "allow" },
    ])
  })

  test("a declared rule that covers the profile leaves nothing missing", () => {
    expect(missingAllowRules(requiredAllowRules(profile({ sensitive: true })), profile({ sensitive: true }))).toEqual([])
    expect(missingAllowRules([], profile({ sensitive: true }))).toHaveLength(1)
  })

  test("only allow rules for the browser permissions are read; a denial is dropped", () => {
    expect(
      allowRulesFrom([
        { permission: "browser", pattern: " https://example.com ", action: "allow" },
        { permission: "browser_sensitive", pattern: "https://example.com:publish", action: "deny" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "browser", pattern: "", action: "allow" },
        "nope",
      ]),
    ).toEqual([{ permission: "browser", pattern: "https://example.com", action: "allow" }])
    expect(allowRulesFrom(undefined)).toEqual([])
  })
})

describe("what is wrong with a routine's action inputs (WA-7)", () => {
  test("a missing or wrongly typed input is named", () => {
    expect(actionInputProblem(profile({ inputs: { text: "string" } }), {})).toContain('"text"')
    expect(actionInputProblem(profile({ inputs: { text: "string" } }), { text: 3 })).toContain("string")
    expect(actionInputProblem(profile({ inputs: { text: "string" } }), { text: "" })).toContain("empty")
    expect(actionInputProblem(profile({ inputs: { image: "image" } }), { image: "not-an-image" })).toContain("image")
    expect(actionInputProblem(profile({ inputs: { text: "string" } }), { text: "hi", extra: "x" })).toContain("extra")
  })

  test("a data URL or an artifact id fills an image input", () => {
    expect(actionInputProblem(profile({ inputs: { image: "image" } }), { image: { artifactId: "a1" } })).toBeUndefined()
    expect(actionInputProblem(profile({ inputs: { image: "image" } }), { image: "data:image/png;base64,AAAA" })).toBeUndefined()
  })
})
