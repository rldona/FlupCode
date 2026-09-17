import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionInfo, SessionMessageInfo } from "./engine-types"
import {
  computeMetrics,
  contextFigures,
  filterByRange,
  formatTokens,
  activityByDay,
  sessionCost,
  stepCost,
} from "./metrics"

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
    const metrics = computeMetrics([session(now, 100), session(now, 200, "model-a"), session(now, 300, "model-a")])
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

describe("sessionCost", () => {
  const prices = [
    { input: 1, output: 4, cache: { read: 0.1, write: 2 } },
    { tier: { type: "context" as const, size: 3_000_000 }, input: 2, output: 8, cache: { read: 0.2, write: 4 } },
  ]
  const models = [{ providerID: "p", id: "m", cost: prices }] as unknown as ModelInfo[]
  const step = (tokens: { input: number; output: number; reasoning: number; read: number }, cost = 0) =>
    ({
      type: "assistant",
      model: { providerID: "p", id: "m" },
      cost,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: 0 },
      },
    }) as unknown as SessionMessageInfo

  test("prices reasoning at the output rate and cache reads at their own", () => {
    expect(
      stepCost({ input: 1_000_000, output: 500_000, reasoning: 500_000, cache: { read: 1_000_000, write: 0 } }, prices),
    ).toBeCloseTo(1 + 4 + 0.1)
  })

  test("uses the largest context tier a step went over", () => {
    expect(
      stepCost({ input: 2_000_000, output: 0, reasoning: 0, cache: { read: 2_000_000, write: 0 } }, prices),
    ).toBeCloseTo(4 + 0.4)
  })

  test("adds priced v2 steps to the legacy total and keeps a cost the engine recorded", () => {
    const legacy = { ...session(Date.now()), cost: 0.5 }
    const messages = [
      { type: "user" } as unknown as SessionMessageInfo,
      step({ input: 1_000_000, output: 0, reasoning: 0, read: 0 }),
      step({ input: 1_000_000, output: 0, reasoning: 0, read: 0 }, 0.25),
    ]
    expect(sessionCost(legacy, messages, models)).toBeCloseTo(0.5 + 1 + 0.25)
  })
})

describe("contextFigures", () => {
  const step = (tokens: { input: number; output?: number; reasoning?: number; read?: number }) =>
    ({
      type: "assistant",
      tokens: {
        input: tokens.input,
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.read ?? 0, write: 0 },
      },
    }) as unknown as SessionMessageInfo

  const prompt = (chars: number) => ({ type: "user", text: "x".repeat(chars) }) as unknown as SessionMessageInfo

  const summary = (text: string) =>
    ({
      type: "assistant",
      summary: true,
      tokens: { input: 474_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text }],
    }) as unknown as SessionMessageInfo

  test("keeps the last step that reported tokens while the running step has none", () => {
    const messages = [
      step({ input: 90_000, read: 3_000 }),
      { type: "assistant", content: [] } as unknown as SessionMessageInfo,
    ]
    expect(contextFigures(session(Date.now(), 0), messages, [], 200_000).used).toBe(93_000)
  })

  test("skips all-zero readings", () => {
    const empty = {
      type: "assistant",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as SessionMessageInfo
    expect(contextFigures(session(Date.now(), 0), [step({ input: 50_000 }), empty], [], 200_000).used).toBe(50_000)
  })

  test("falls back to the session totals when no step reported tokens", () => {
    const messages = [{ type: "user" } as unknown as SessionMessageInfo]
    expect(contextFigures(session(Date.now(), 100), messages, [], 200_000).used).toBe(100)
  })

  test("sizes the session the compaction left, not the history it summarized", () => {
    const messages = [
      prompt(400),
      step({ input: 10_100 }),
      step({ input: 470_000, read: 4_000 }),
      summary("x".repeat(400)),
    ]
    const figures = contextFigures(session(Date.now(), 0), messages, [], 1_000_000)
    // The wrap the first step paid (10,100 less the 100 tokens of the prompt before it) is what the
    // next prompt pays too, plus the summary the engine kept. The 474k the summary itself reports is
    // the request that wrote it — the history the reader just watched go away.
    expect(figures.used).toBe(10_100)
    expect(figures.estimated).toBe(true)
    expect(figures.tokens).toBeUndefined()
  })

  test("sizes a v2 compaction from the summary and tail it kept", () => {
    const messages = [
      prompt(400),
      step({ input: 10_100 }),
      {
        type: "compaction",
        reason: "auto",
        summary: "s".repeat(400),
        recent: "r".repeat(400),
      } as unknown as SessionMessageInfo,
    ]
    expect(contextFigures(session(Date.now(), 0), messages, [], 1_000_000).used).toBe(10_200)
  })

  test("sizes only the kept text when no message came before the first step", () => {
    // Without a prompt before it there is no telling the engine's wrap from the prompt itself, so
    // reading the whole step as the wrap would invent a standing cost out of the history.
    const messages = [step({ input: 470_000, read: 4_000 }), summary("x".repeat(4_000))]
    expect(contextFigures(session(Date.now(), 0), messages, [], 1_000_000).used).toBe(1_000)
  })

  test("a step after the compaction measures it again", () => {
    const messages = [
      prompt(400),
      step({ input: 10_100 }),
      summary("x".repeat(400)),
      step({ input: 10_000, read: 11_000 }),
    ]
    const figures = contextFigures(session(Date.now(), 0), messages, [], 1_000_000)
    expect(figures.used).toBe(21_000)
    expect(figures.estimated).toBeUndefined()
  })
})
