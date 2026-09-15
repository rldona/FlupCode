import { describe, expect, test } from "bun:test"
import { routineDue } from "./routines"
import type { Routine } from "./types"

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "routine_1",
  name: "check the release notes",
  prompt: "check the release notes",
  intervalMinutes: 60,
  enabled: true,
  createdAt: 0,
  ...overrides,
})

const now = 1_000_000_000_000

describe("routineDue", () => {
  test("runs an enabled routine that never ran", () => {
    expect(routineDue(routine(), now)).toBe(true)
  })

  test("waits for the interval since the last run", () => {
    expect(routineDue(routine({ lastRunAt: now - 59 * 60_000 }), now)).toBe(false)
    expect(routineDue(routine({ lastRunAt: now - 60 * 60_000 }), now)).toBe(true)
  })

  test("never runs a paused routine", () => {
    expect(routineDue(routine({ enabled: false }), now)).toBe(false)
  })

  // A routine stored by an older build can carry 0, which made `now - lastRunAt` always win and
  // fired a session on every tick.
  test("never runs without a positive interval", () => {
    for (const intervalMinutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(routineDue(routine({ intervalMinutes, lastRunAt: now }), now)).toBe(false)
      expect(routineDue(routine({ intervalMinutes }), now)).toBe(false)
    }
  })
})
