import { expect, test } from "bun:test"
import { PERMISSION_MODES, permissionMode } from "./permission-modes"

const grants = (rules: Array<{ permission: string; action: string }>) =>
  rules.filter((rule) => rule.action === "allow").map((rule) => rule.permission)

test("only the bypass mode grants everything, and it says so", () => {
  for (const mode of PERMISSION_MODES) {
    const wildcardGrant = grants(mode.rules).includes("*")
    expect(wildcardGrant).toBe(mode.id === "bypass")
    expect(!!mode.dangerous).toBe(mode.id === "bypass")
  }
})

test("the default mode adds no allow of its own", () => {
  const auto = permissionMode(undefined)
  expect(auto.id).toBe("auto")
  expect(grants(auto.rules)).toEqual([])
  // What it does add is confirmation, never a grant.
  expect(auto.rules.every((rule) => rule.action === "ask")).toBe(true)
})

test("auto confirms browser effects while navigation stays with the agent", () => {
  expect(permissionMode("auto").rules.find((rule) => rule.permission === "browser_sensitive")).toEqual({
    permission: "browser_sensitive",
    pattern: "*",
    action: "ask",
  })
  expect(permissionMode("auto").rules.find((rule) => rule.permission === "browser")).toBeUndefined()
})

test("manual and accept-edits resolve browser requests by asking", () => {
  for (const id of ["manual", "accept-edits"]) {
    const mode = permissionMode(id)
    for (const permission of ["browser", "browser_sensitive"]) {
      const rule = mode.rules.find((entry) => entry.permission === permission) ?? mode.rules.find((entry) => entry.permission === "*")
      expect(rule?.action).toBe("ask")
    }
  }
})

test("bypass says it covers browser actions too", () => {
  expect(permissionMode("bypass").description).toContain("browser")
})

test("work outside the session's folder is always confirmed unless permissions are bypassed", () => {
  for (const mode of PERMISSION_MODES.filter((mode) => !mode.dangerous)) {
    const external = mode.rules.find((rule) => rule.permission === "external_directory")
    const wildcard = mode.rules.find((rule) => rule.permission === "*")
    expect(external?.action ?? wildcard?.action).toBe("ask")
  }
})
