import { describe, expect, test } from "bun:test"
import { isDue, nextRunAt } from "./schedule"
import type { Routine } from "./types"

const routine = (schedule: Routine["schedule"], overrides: Partial<Routine> = {}): Routine => ({
  id: "routine_test",
  name: "Test routine",
  description: "",
  prompt: "Check the project",
  schedule,
  enabled: true,
  createdAt: new Date(2026, 0, 5, 8, 0).getTime(),
  runs: [],
  ...overrides,
})

describe("server routine scheduler", () => {
  test("does not schedule manual or disabled routines", () => {
    expect(nextRunAt(routine({ type: "manual" }), Date.now())).toBeUndefined()
    expect(nextRunAt(routine({ type: "hourly" }, { enabled: false }), Date.now())).toBeUndefined()
  })

  test("detects a daily routine when its scheduled time has passed", () => {
    const now = new Date(2026, 0, 5, 9, 1).getTime()
    const scheduled = routine({ type: "daily", time: "09:00" })
    expect(isDue(scheduled, now)).toBe(true)
    expect(nextRunAt({ ...scheduled, lastRunAt: now }, now)).toBe(new Date(2026, 0, 6, 9, 0).getTime())
  })

  test("skips weekends", () => {
    const friday = new Date(2026, 0, 9, 16, 0).getTime()
    const scheduled = routine({ type: "weekdays", time: "09:00" }, { createdAt: friday })
    expect(nextRunAt(scheduled, friday)).toBe(new Date(2026, 0, 12, 9, 0).getTime())
  })
})
