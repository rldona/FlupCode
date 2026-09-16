import { describe, expect, test } from "bun:test"
import { normalizeRoutineSchedule, routineIsDue, routineNextRunAt } from "./routine-schedule"
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

describe("routine schedule", () => {
  test("does not schedule manual or paused routines", () => {
    expect(routineNextRunAt(routine({ type: "manual" }))).toBeUndefined()
    expect(routineNextRunAt(routine({ type: "hourly" }, { enabled: false }))).toBeUndefined()
  })

  test("calculates the next daily run and due state", () => {
    const now = new Date(2026, 0, 5, 8, 30).getTime()
    const scheduled = routine({ type: "daily", time: "09:00" })
    expect(routineNextRunAt(scheduled, now)).toBe(new Date(2026, 0, 5, 9, 0).getTime())
    expect(routineIsDue(scheduled, new Date(2026, 0, 5, 9, 1).getTime())).toBe(true)
  })

  test("skips weekends for weekday schedules", () => {
    const friday = new Date(2026, 0, 9, 16, 0).getTime()
    const scheduled = routine({ type: "weekdays", time: "09:00" }, { createdAt: friday })
    expect(routineNextRunAt(scheduled, friday)).toBe(new Date(2026, 0, 12, 9, 0).getTime())
  })

  test("normalizes legacy and invalid schedules safely", () => {
    expect(normalizeRoutineSchedule(undefined, 30)).toEqual({ type: "interval", intervalMinutes: 30 })
    expect(normalizeRoutineSchedule({ type: "weekly", day: 9 }, 30)).toEqual({
      type: "weekly",
      day: 1,
      time: "09:00",
    })
    expect(normalizeRoutineSchedule({ type: "interval", intervalMinutes: -1 }, 30)).toEqual({
      type: "interval",
      intervalMinutes: 30,
    })
  })
})
