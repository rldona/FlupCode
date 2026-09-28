import { expect, test } from "bun:test"
import { isPlaceholderTitle, sessionTitle } from "./session-title"

test("the engine's placeholder is shown as a readable stamp, not the raw ISO", () => {
  expect(isPlaceholderTitle("New session - 2026-09-16T10:11:12.345Z")).toBe(true)
  expect(isPlaceholderTitle("Child session - 2026-09-16T10:11:12.345Z")).toBe(true)
  const named = sessionTitle({ title: "New session - 2026-09-16T10:11:12.345Z" })
  expect(named.startsWith("New session · ")).toBe(true)
  expect(named).not.toContain("2026-09-16T")
  expect(sessionTitle({ title: "Child session - 2026-09-16T10:11:12.345Z" }).startsWith("Child session · ")).toBe(true)
})

test("a name the engine chose is shown as it is", () => {
  expect(isPlaceholderTitle("Fix the scroll state")).toBe(false)
  expect(sessionTitle({ title: "Fix the scroll state" })).toBe("Fix the scroll state")
})

test("no title at all counts as a placeholder", () => {
  expect(isPlaceholderTitle(undefined)).toBe(true)
  expect(sessionTitle(undefined)).toBe("")
})
