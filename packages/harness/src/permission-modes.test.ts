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

test("the default mode adds no grant of its own", () => {
  expect(grants(permissionMode(undefined).rules)).toEqual([])
  expect(permissionMode(undefined).id).toBe("auto")
})

test("work outside the session's folder is always confirmed unless permissions are bypassed", () => {
  for (const mode of PERMISSION_MODES.filter((mode) => !mode.dangerous)) {
    const external = mode.rules.find((rule) => rule.permission === "external_directory")
    const wildcard = mode.rules.find((rule) => rule.permission === "*")
    expect(external?.action ?? wildcard?.action).toBe("ask")
  }
})
