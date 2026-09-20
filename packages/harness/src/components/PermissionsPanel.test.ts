import { describe, expect, test } from "bun:test"
import { mergePolicy, normalizePolicy } from "./PermissionsPanel"

describe("reading the engine's permission policy", () => {
  test("a plain action is the rule for everything", () => {
    expect(normalizePolicy("deny")).toEqual({ actions: { "*": "deny" }, other: {} })
  })

  test("actions are editable, pattern maps are kept aside", () => {
    expect(
      normalizePolicy({ edit: "allow", bash: { "rm -rf *": "deny" }, "*": "ask" }),
    ).toEqual({
      actions: { edit: "allow", "*": "ask" },
      other: { bash: { "rm -rf *": "deny" } },
    })
  })

  test("nothing, or something that is not a policy, reads as empty", () => {
    expect(normalizePolicy(undefined)).toEqual({ actions: {}, other: {} })
    expect(normalizePolicy(["ask"])).toEqual({ actions: {}, other: {} })
    expect(normalizePolicy(42)).toEqual({ actions: {}, other: {} })
  })
})

describe("writing it back", () => {
  test("a key set back to default is dropped, not written empty", () => {
    expect(mergePolicy({ edit: "allow", bash: undefined }, {})).toEqual({ edit: "allow" })
  })

  test("pattern maps survive a save the form did not touch", () => {
    const normal = normalizePolicy({ bash: { "rm -rf *": "deny" }, edit: "allow" })
    expect(mergePolicy({ ...normal.actions, edit: "deny" }, normal.other)).toEqual({
      bash: { "rm -rf *": "deny" },
      edit: "deny",
    })
  })
})
