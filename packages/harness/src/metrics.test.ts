import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionInfo, SessionMessageInfo } from "./engine-types"
import { activityDays, compactionAt, compactionNear, contextFigures, formatTokens } from "./metrics"

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

describe("formatTokens", () => {
  test("formats thousands and millions", () => {
    expect(formatTokens(500)).toBe("500")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(2_000_000)).toBe("2.0M")
  })
})

describe("activityDays", () => {
  test("lays the engine's days over the last local days, oldest first, with the missing ones at zero", () => {
    const now = new Date(2026, 9, 3, 0, 30).getTime()
    const days = activityDays(
      [
        { date: "2026-09-27", steps: 4 },
        { date: "2026-10-02", steps: 1 },
        { date: "2026-10-03", steps: 7 },
      ],
      7,
      now,
    )
    expect(days.map((day) => day.count)).toEqual([4, 0, 0, 0, 0, 1, 7])
    // One number per day, in a row, today's being the days from the epoch to its local date.
    expect(days.at(-1)?.day).toBe(Date.UTC(2026, 9, 3) / 86_400_000)
    expect(days.map((day, index) => day.day - index)).toEqual(Array(7).fill(days[0]!.day))
  })

  test("a day the engine lists outside the window is left out", () => {
    const now = new Date(2026, 9, 3, 12).getTime()
    expect(activityDays([{ date: "2026-09-01", steps: 3 }], 3, now).map((day) => day.count)).toEqual([0, 0, 0])
  })
})

describe("contextFigures", () => {
  const model = (context: number, extra: { input?: number; output?: number } = {}) =>
    ({
      limit: { context, output: extra.output ?? 0, ...(extra.input === undefined ? {} : { input: extra.input }) },
    }) as unknown as ModelInfo

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
    expect(contextFigures(session(Date.now(), 0), messages, model(200_000)).used).toBe(93_000)
  })

  test("skips all-zero readings", () => {
    const empty = {
      type: "assistant",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as SessionMessageInfo
    expect(contextFigures(session(Date.now(), 0), [step({ input: 50_000 }), empty], model(200_000)).used).toBe(50_000)
  })

  test("falls back to the session totals when no step reported tokens", () => {
    const messages = [{ type: "user" } as unknown as SessionMessageInfo]
    expect(contextFigures(session(Date.now(), 100), messages, model(200_000)).used).toBe(100)
  })

  test("sizes the session the compaction left, not the history it summarized", () => {
    const messages = [
      prompt(400),
      step({ input: 10_100 }),
      step({ input: 470_000, read: 4_000 }),
      summary("x".repeat(400)),
    ]
    const figures = contextFigures(session(Date.now(), 0), messages, model(1_000_000))
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
    expect(contextFigures(session(Date.now(), 0), messages, model(1_000_000)).used).toBe(10_200)
  })

  test("sizes only the kept text when no message came before the first step", () => {
    // Without a prompt before it there is no telling the engine's wrap from the prompt itself, so
    // reading the whole step as the wrap would invent a standing cost out of the history.
    const messages = [step({ input: 470_000, read: 4_000 }), summary("x".repeat(4_000))]
    expect(contextFigures(session(Date.now(), 0), messages, model(1_000_000)).used).toBe(1_000)
  })

  test("a step after the compaction measures it again", () => {
    const messages = [
      prompt(400),
      step({ input: 10_100 }),
      summary("x".repeat(400)),
      step({ input: 10_000, read: 11_000 }),
    ]
    const figures = contextFigures(session(Date.now(), 0), messages, model(1_000_000))
    expect(figures.used).toBe(21_000)
    expect(figures.estimated).toBeUndefined()
  })

  test("reports what the engine counts against its own point, caches and answer included", () => {
    // The engine compares input + output + both caches, not the prompt alone.
    const messages = [step({ input: 90_000, output: 400, read: 3_000 })]
    const figures = contextFigures(session(Date.now(), 0), messages, model(200_000), { reserved: 5_000 })
    expect(figures.compaction).toEqual({ at: 200_000 - 32_000, count: 93_400 })
  })

  test("says nothing about a compaction while the figure is an estimate", () => {
    const messages = [prompt(400), step({ input: 10_100 }), summary("x".repeat(400))]
    const figures = contextFigures(session(Date.now(), 0), messages, model(1_000_000), { reserved: 5_000 })
    expect(figures.estimated).toBe(true)
    expect(figures.compaction).toBeUndefined()
  })

  test("says nothing when the engine will not compact this session", () => {
    const messages = [step({ input: 90_000 })]
    const off = contextFigures(session(Date.now(), 0), messages, model(200_000), { auto: false })
    expect(off.compaction).toBeUndefined()
    const unknown = contextFigures(session(Date.now(), 0), messages, model(0))
    expect(unknown.compaction).toBeUndefined()
  })
})

describe("compactionAt", () => {
  const model = (limit: { context: number; input?: number; output: number }) => ({ limit }) as unknown as ModelInfo

  test("keeps the answer's room, which is what the engine's own buffer stands for", () => {
    // `min(limit.output, 32k)` off the window: 8k of room here.
    expect(compactionAt(model({ context: 200_000, output: 8_000 }))).toBe(192_000)
    // A model that can answer with more than the engine ever asks for is capped at 32k.
    expect(compactionAt(model({ context: 200_000, output: 64_000 }))).toBe(168_000)
  })

  test("holds back the configured reserve, and counts from the input limit when there is one", () => {
    // Without a reported input limit the engine takes the answer's room off the window, whatever the
    // reserve says: `reserved` only enters its own branch of that rule.
    expect(compactionAt(model({ context: 200_000, output: 8_000 }), { reserved: 5_000 })).toBe(192_000)
    expect(compactionAt(model({ context: 200_000, input: 190_000, output: 8_000 }))).toBe(182_000)
    expect(compactionAt(model({ context: 200_000, input: 190_000, output: 8_000 }), { reserved: 5_000 })).toBe(185_000)
  })

  test("nothing to warn about when the engine will not compact", () => {
    expect(compactionAt(model({ context: 200_000, output: 8_000 }), { auto: false })).toBeUndefined()
    expect(compactionAt(model({ context: 0, output: 8_000 }))).toBeUndefined()
    expect(compactionAt(undefined)).toBeUndefined()
  })
})

describe("compactionNear", () => {
  test("warns over the last tenth of the budget, and not before it", () => {
    expect(compactionNear({ at: 100_000, count: 89_000 })).toBe(false)
    expect(compactionNear({ at: 100_000, count: 90_000 })).toBe(true)
    expect(compactionNear({ at: 100_000, count: 100_000 })).toBe(true)
    expect(compactionNear(undefined)).toBe(false)
  })
})
