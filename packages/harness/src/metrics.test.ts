import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode-ai/client"
import { computeMetrics, filterByRange, formatTokens, activityByDay } from "./metrics"

const DAY = 86_400_000

function session(created: number, tokens = 0, model?: string): SessionInfo {
  return {
    id: `ses-${created}-${model ?? "x"}-${tokens}`,
    projectID: "proj",
    cost: 0,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created },
    title: "session",
    location: { directory: "/tmp" },
    ...(model ? { model: { id: model, providerID: "p" } } : {}),
  }
}

describe("computeMetrics", () => {
  test("sums tokens and counts sessions", () => {
    const now = Date.now()
    const metrics = computeMetrics([
      session(now, 100),
      session(now, 200, "model-a"),
      session(now, 300, "model-a"),
    ])
    expect(metrics.sessions).toBe(3)
    expect(metrics.tokens).toBe(600)
    expect(metrics.activeDays).toBe(1)
    expect(metrics.favoriteModel).toBe("model-a")
  })

  test("computes current and longest streaks across consecutive days", () => {
    const midnight = Math.floor(Date.now() / DAY) * DAY
    const metrics = computeMetrics([
      session(midnight),
      session(midnight - DAY),
      session(midnight - 2 * DAY),
      session(midnight - 10 * DAY),
    ])
    expect(metrics.longestStreak).toBe(3)
    expect(metrics.currentStreak).toBe(3)
  })

  test("picks the peak hour", () => {
    const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
    const metrics = computeMetrics([session(base), session(base + 60_000), session(base + 3 * 3600_000)])
    expect(metrics.peakHour).toBe("9:00")
  })
})

describe("filterByRange", () => {
  test("keeps only sessions inside the range", () => {
    const now = Date.now()
    const sessions = [session(now), session(now - 3 * DAY), session(now - 20 * DAY)]
    expect(filterByRange(sessions, "7d")).toHaveLength(2)
    expect(filterByRange(sessions, "30d")).toHaveLength(3)
    expect(filterByRange(sessions, "all")).toHaveLength(3)
  })
})

describe("formatTokens", () => {
  test("formats thousands and millions", () => {
    expect(formatTokens(500)).toBe("500")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(2_000_000)).toBe("2.0M")
  })
})

describe("activityByDay", () => {
  test("returns one entry per day ending today", () => {
    const now = Date.now()
    const days = activityByDay([session(now)], 7)
    expect(days).toHaveLength(7)
    expect(days.at(-1)?.count).toBe(1)
  })
})
