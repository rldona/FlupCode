import { describe, expect, test } from "bun:test"
import { mergePolicy, normalizePolicy } from "./PermissionsPanel"

describe("reading the engine's permission policy", () => {
  test("a plain action is the rule for everything", () => {
    expect(normalizePolicy("deny")).toEqual({ actions: { "*": "deny" }, rules: [], other: {} })
  })

  test("pattern maps become editable rules, the rest is kept aside", () => {
    expect(
      normalizePolicy({ edit: "allow", bash: { "rm -rf *": "deny" }, "*": "ask" }),
    ).toEqual({
      actions: { edit: "allow", "*": "ask" },
      rules: [{ tool: "bash", pattern: "rm -rf *", action: "deny" }],
      other: {},
    })
  })

  test("a mixed map is not rules, so nothing is silently flattened", () => {
    const raw = { bash: { "rm -rf *": "deny", nested: { deep: true } } }
    expect(normalizePolicy(raw)).toEqual({ actions: {}, rules: [], other: raw })
  })

  test("nothing, or something that is not a policy, reads as empty", () => {
    expect(normalizePolicy(undefined)).toEqual({ actions: {}, rules: [], other: {} })
    expect(normalizePolicy(["ask"])).toEqual({ actions: {}, rules: [], other: {} })
    expect(normalizePolicy(42)).toEqual({ actions: {}, rules: [], other: {} })
  })
})

describe("writing it back", () => {
  test("a key set back to default is dropped, not written empty", () => {
    expect(mergePolicy({ edit: "allow", bash: undefined }, [], {})).toEqual({ edit: "allow" })
  })

  test("rules become maps again, and a tool left without rules loses its map", () => {
    expect(
      mergePolicy({ edit: "deny" }, [{ tool: "bash", pattern: "rm -rf *", action: "deny" }], {}),
    ).toEqual({ bash: { "rm -rf *": "deny" }, edit: "deny" })
    // Parsed maps never reach `other`, so deleting every rule of a tool drops its map.
    const normal = normalizePolicy({ bash: { "rm -rf *": "deny" } })
    expect(mergePolicy({}, [], normal.other)).toEqual({})
  })

  test("a rule without tool or pattern is not written", () => {
    expect(mergePolicy({}, [{ tool: "", pattern: "x", action: "deny" }], {})).toEqual({})
    expect(mergePolicy({}, [{ tool: "bash", pattern: "  ", action: "deny" }], {})).toEqual({})
  })

  test("what the form never understood survives a save", () => {
    const normal = normalizePolicy({ custom: { deep: true }, edit: "allow" })
    expect(mergePolicy({ ...normal.actions }, normal.rules, normal.other)).toEqual({
      custom: { deep: true },
      edit: "allow",
    })
  })
})
