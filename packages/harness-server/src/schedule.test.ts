import { describe, expect, test } from "bun:test"
import { failedInARow, isDue, nextFiring, nextRunAt, scheduleProblem } from "./schedule"
import type { Routine, Run } from "./types"

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

const at = (iso: string) => new Date(iso).getTime()
const MINUTE = 60_000

/** The next `count` firings, each computed as the scheduler would after the previous one ran. */
const firings = (scheduled: Routine, from: number, count: number) =>
  Array.from({ length: count }).reduce<number[]>((times) => {
    const lastRunAt = times.at(-1) ?? from
    const next = nextRunAt({ ...scheduled, lastRunAt }, lastRunAt)
    return next === undefined ? times : [...times, next]
  }, [])

const iso = (times: number[]) => times.map((time) => new Date(time).toISOString())

const run = (overrides: Partial<Run>): Run => ({
  id: crypto.randomUUID(),
  source: { type: "routine", routineID: "routine_test" },
  status: "success",
  startedAt: 0,
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

describe("a routine's time zone (RP-07)", () => {
  // Madrid is UTC+1 in winter and UTC+2 in summer: 08:15 there is 07:15Z, then 06:15Z.
  test("08:15 Europe/Madrid stays 08:15 there across the spring change", () => {
    const daily = routine({ type: "daily", time: "08:15", timezone: "Europe/Madrid" })
    expect(iso(firings(daily, at("2026-03-27T12:00:00Z"), 3))).toEqual([
      "2026-03-28T07:15:00.000Z",
      "2026-03-29T06:15:00.000Z",
      "2026-03-30T06:15:00.000Z",
    ])
  })

  test("and across the autumn change", () => {
    const daily = routine({ type: "daily", time: "08:15", timezone: "Europe/Madrid" })
    expect(iso(firings(daily, at("2026-10-23T12:00:00Z"), 3))).toEqual([
      "2026-10-24T06:15:00.000Z",
      "2026-10-25T07:15:00.000Z",
      "2026-10-26T07:15:00.000Z",
    ])
  })

  test("a time the spring change skips runs that day, as late as the change pushed it", () => {
    // 02:30 does not exist in Madrid on 29 March 2026: clocks go from 02:00 to 03:00.
    const daily = routine({ type: "daily", time: "02:30", timezone: "Europe/Madrid" })
    expect(iso(firings(daily, at("2026-03-28T12:00:00Z"), 2))).toEqual([
      "2026-03-29T01:30:00.000Z", // 03:30 summer time
      "2026-03-30T00:30:00.000Z",
    ])
  })

  test("a time the autumn change repeats runs once, the first time it comes round", () => {
    // 02:30 happens twice in Madrid on 25 October 2026: at 00:30Z (summer) and 01:30Z (winter).
    const daily = routine({ type: "daily", time: "02:30", timezone: "Europe/Madrid" })
    expect(iso(firings(daily, at("2026-10-24T12:00:00Z"), 2))).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ])
  })

  test("a weekday and a weekly routine read their day in their own zone", () => {
    // 14:00Z on a Friday is 23:00 in Tokyo, past 09:00: the next weekday there is Monday.
    const friday = at("2026-01-09T14:00:00Z")
    const weekdays = routine({ type: "weekdays", time: "09:00", timezone: "Asia/Tokyo" }, { createdAt: friday })
    expect(new Date(nextRunAt(weekdays, friday)!).toISOString()).toBe("2026-01-12T00:00:00.000Z")
    const weekly = routine({ type: "weekly", day: 0, time: "18:00", timezone: "America/New_York" }, { createdAt: friday })
    expect(new Date(nextRunAt(weekly, friday)!).toISOString()).toBe("2026-01-11T23:00:00.000Z")
  })

  test("a cron expression runs in the routine's zone", () => {
    const cron = routine(
      { type: "cron", expression: "30 9-10 * * 1-5", timezone: "Europe/Madrid" },
      { createdAt: at("2026-07-03T06:00:00Z") },
    )
    expect(iso(firings(cron, at("2026-07-03T06:00:00Z"), 3))).toEqual([
      "2026-07-03T07:30:00.000Z",
      "2026-07-03T08:30:00.000Z",
      "2026-07-06T07:30:00.000Z",
    ])
  })

  test("hourly and interval routines count elapsed time, whatever the zone", () => {
    const anchor = at("2026-10-25T00:30:00Z")
    const hourly = routine({ type: "hourly", timezone: "Europe/Madrid" }, { lastRunAt: anchor })
    expect(nextRunAt(hourly, anchor)).toBe(anchor + 60 * MINUTE)
  })

  test("a schedule that cannot fire is refused with its reason", () => {
    expect(scheduleProblem({ type: "cron", expression: "61 * * * *" })).toContain("minute")
    expect(scheduleProblem({ type: "cron", expression: "0 0 30 2 *" })).toBe("This schedule never runs")
    expect(scheduleProblem({ type: "daily", time: "08:15", timezone: "Mars/Olympus" })).toBe(
      "Unknown time zone: Mars/Olympus",
    )
    expect(scheduleProblem({ type: "daily", time: "8.15" })).toBe("Write the time as HH:MM")
    expect(scheduleProblem({ type: "daily", time: "08:15", timezone: "Europe/Madrid" })).toBeUndefined()
  })
})

describe("missed beats (RP-07)", () => {
  const lastRunAt = at("2026-01-05T08:00:00Z")
  const now = at("2026-01-08T10:00:00Z")

  test("catch-up runs once for everything the server slept through", () => {
    const daily = routine({ type: "daily", time: "09:00", timezone: "UTC" }, { lastRunAt })
    expect(nextRunAt(daily, now)).toBe(at("2026-01-05T09:00:00Z"))
    expect(isDue(daily, now)).toBe(true)
  })

  test("skip waits for the next beat instead", () => {
    const daily = routine({ type: "daily", time: "09:00", timezone: "UTC" }, { lastRunAt, missed: "skip" })
    expect(nextRunAt(daily, now)).toBe(at("2026-01-09T09:00:00Z"))
    expect(isDue(daily, now)).toBe(false)
  })

  test("skip still runs a beat the tick reached a little late", () => {
    const daily = routine({ type: "daily", time: "09:00", timezone: "UTC" }, { lastRunAt, missed: "skip" })
    expect(isDue(daily, at("2026-01-05T09:01:00Z"))).toBe(true)
  })

  test("skip on an interval keeps its rhythm", () => {
    const interval = routine({ type: "interval", intervalMinutes: 30 }, { lastRunAt, missed: "skip" })
    expect(nextRunAt(interval, lastRunAt + 97 * MINUTE)).toBe(lastRunAt + 120 * MINUTE)
  })
})

describe("retries (RP-07)", () => {
  const beat = at("2026-01-05T09:00:00Z")
  const daily = (runs: Run[]) =>
    routine(
      { type: "daily", time: "09:00", timezone: "UTC" },
      { lastRunAt: beat, runs, retry: { count: 2, backoffMinutes: 10 } },
    )

  test("a failed run is tried again after the backoff, doubling each time", () => {
    const first = run({ status: "failed", startedAt: beat, finishedAt: beat + MINUTE })
    expect(nextFiring(daily([first]), beat + 2 * MINUTE)).toEqual({ at: beat + 11 * MINUTE, retry: { of: first.id, attempt: 2 } })
    const second = run({ status: "failed", startedAt: beat + 11 * MINUTE, finishedAt: beat + 12 * MINUTE, attempt: 2 })
    expect(nextFiring(daily([second, first]), beat + 13 * MINUTE)).toEqual({
      at: beat + 32 * MINUTE,
      retry: { of: second.id, attempt: 3 },
    })
  })

  test("a run whose verdict failed is retried; one that asks the reader is not", () => {
    const judged = run({ startedAt: beat, finishedAt: beat + MINUTE, verdict: { value: "failed", reason: "gave up", source: "rule", taskID: "t" } })
    expect(nextFiring(daily([judged]), beat + 2 * MINUTE)?.retry).toBeDefined()
    const asked = run({ startedAt: beat, finishedAt: beat + MINUTE, verdict: { value: "needs-user", reason: "which?", source: "rule", taskID: "t" } })
    expect(nextFiring(daily([asked]), beat + 2 * MINUTE)?.retry).toBeUndefined()
  })

  test("once the retries are spent the routine waits for its next beat", () => {
    const third = run({ status: "failed", startedAt: beat + 32 * MINUTE, finishedAt: beat + 33 * MINUTE, attempt: 3 })
    expect(nextFiring(daily([third]), beat + 40 * MINUTE)).toEqual({ at: at("2026-01-06T09:00:00Z") })
  })

  test("a retry that would land after the next beat gives way to the beat", () => {
    const late = run({ status: "failed", startedAt: beat, finishedAt: at("2026-01-06T08:55:00Z") })
    expect(nextFiring(daily([late]), at("2026-01-06T08:56:00Z"))).toEqual({ at: at("2026-01-06T09:00:00Z") })
  })
})

describe("failures in a row (RP-07)", () => {
  const verdict = (value: "verified" | "unverified" | "needs-user" | "failed") => ({
    value,
    reason: "",
    source: "rule" as const,
    taskID: "t",
  })

  test("counts failed runs and failed or unanswered verdicts from the newest", () => {
    expect(
      failedInARow([
        run({ status: "failed" }),
        run({ verdict: verdict("failed") }),
        run({ verdict: verdict("needs-user") }),
        run({ verdict: verdict("verified") }),
        run({ status: "failed" }),
      ]),
    ).toBe(3)
  })

  test("a run nothing checked ends the count: not verified is not a failure", () => {
    expect(failedInARow([run({ status: "failed" }), run({ verdict: verdict("unverified") }), run({ status: "failed" })])).toBe(1)
  })

  test("runs still going and runs somebody stopped neither count nor break it", () => {
    expect(
      failedInARow([
        run({ status: "running" }),
        run({ status: "failed" }),
        run({ status: "stopped" }),
        run({ status: "failed" }),
      ]),
    ).toBe(2)
  })
})
