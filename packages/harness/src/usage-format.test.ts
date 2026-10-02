import { describe, expect, test } from "bun:test"
import { dayKeys, duration, periodStart, share } from "./components/UsagePanel"

describe("duration", () => {
  test("reads as a person would say it", () => {
    expect(duration(4_000)).toBe("4s")
    expect(duration(95_000)).toBe("1m 35s")
    expect(duration(3_725_000)).toBe("1h 02m")
  })

  test("pads, so a column of them lines up", () => {
    expect(duration(61_000)).toBe("1m 01s")
  })
})

describe("share", () => {
  test("is a percentage", () => {
    expect(share(1, 4)).toBe(25)
    expect(share(2, 3)).toBe(67)
  })

  test("nothing divided by nothing is nothing, not NaN", () => {
    // A report with no cost at all would otherwise render bars of width "NaN%".
    expect(share(0, 0)).toBe(0)
    expect(share(5, 0)).toBe(0)
  })
})

describe("the daily series", () => {
  const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime()

  test("a period of n days starts at midnight of its first day and has n slots", () => {
    const now = at(8, 30, 15)
    expect(periodStart(7, now)).toBe(new Date(2026, 8, 24).getTime())
    expect(dayKeys(periodStart(7, now), now)).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ])
  })

  test("names days as the ledger does, across a month end and a clock change", () => {
    // Late October has the European clock change: a 25-hour day must not lose or repeat a slot.
    const keys = dayKeys(at(9, 24), at(10, 2))
    expect(keys[0]).toBe("2026-10-24")
    expect(keys.at(-1)).toBe("2026-11-02")
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(10)
  })
})
