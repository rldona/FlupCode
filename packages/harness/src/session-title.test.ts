import { expect, test } from "bun:test"
import { isPlaceholderTitle, sessionTitle } from "./session-title"

test("the engine's own placeholder is never shown to the reader", () => {
  expect(isPlaceholderTitle("New session - 2026-09-16T10:11:12.345Z")).toBe(true)
  expect(isPlaceholderTitle("Child session - 2026-09-16T10:11:12.345Z")).toBe(true)
  expect(sessionTitle({ title: "New session - 2026-09-16T10:11:12.345Z" })).toBe("")
})

test("a name the engine chose is shown as it is", () => {
  expect(isPlaceholderTitle("Fix the scroll state")).toBe(false)
  expect(sessionTitle({ title: "Fix the scroll state" })).toBe("Fix the scroll state")
})

test("no title at all counts as a placeholder", () => {
  expect(isPlaceholderTitle(undefined)).toBe(true)
  expect(sessionTitle(undefined)).toBe("")
})
