/**
 * What each session cost (AH-B02): the summary's arithmetic, the repository's window and the route.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { MetricObservation, SessionMetricTurn } from "./session-metrics"
import { cachedShare, clampLimit, percentile, summariseSessions } from "./session-summary"

const ADAPTIVE = "adaptive-secret"
const BROWSER = "browser-secret"

const turn = (over: Partial<SessionMetricTurn> & { sessionID: string; turn: number }): SessionMetricTurn => ({
  turnID: `${over.sessionID}-${over.turn}`,
  requests: 1,
  tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 300, cacheWrite: 100 },
  cost: 0.01,
  modelMs: 1000,
  toolCalls: 0,
  toolErrors: 0,
  toolOutputBytes: 0,
  tools: {},
  compactions: 0,
  skills: [],
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
})

describe("percentile", () => {
  test("is the nearest rank, so it is always a value that happened", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(100)
    expect(percentile([7], 50)).toBe(7)
    expect(percentile([7], 95)).toBe(7)
  })

  test("does not care about the order it is handed, and an empty set has none", () => {
    expect(percentile([90, 10, 50], 50)).toBe(50)
    expect(percentile([], 50)).toBeUndefined()
  })

  test("the tail of twenty turns is the nineteenth, not the slowest outlier alone", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(percentile(values, 95)).toBe(19)
  })
})

describe("cachedShare", () => {
  test("is what was read from the cache over the whole prompt", () => {
    expect(cachedShare({ input: 100, output: 999, reasoning: 999, cacheRead: 300, cacheWrite: 100 })).toBe(0.6)
  })

  test("is nothing, not NaN, when nothing was sent", () => {
    expect(cachedShare({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })
})

describe("summariseSessions", () => {
  test("adds a session's turns up and names the model its last turn used", () => {
    const report = summariseSessions([
      turn({ sessionID: "a", turn: 1, modelID: "sonnet", providerID: "anthropic", firstTokenMs: 200, projectID: "/w" }),
      turn({ sessionID: "a", turn: 2, modelID: "opus", providerID: "anthropic", firstTokenMs: 400, endedAt: 5_000 }),
    ])
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]).toMatchObject({
      sessionID: "a",
      projectID: "/w",
      modelID: "opus",
      turns: 2,
      requests: 2,
      tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 600, cacheWrite: 200, total: 1100 },
      cached: 0.6,
      startedAt: 1_000,
      endedAt: 5_000,
    })
    expect(report.sessions[0]!.cost).toBeCloseTo(0.02)
  })

  test("the turn latency is end minus start, and the first token only counts turns that measured it", () => {
    const report = summariseSessions([
      turn({ sessionID: "a", turn: 1, startedAt: 0, endedAt: 1_000, firstTokenMs: 100 }),
      turn({ sessionID: "a", turn: 2, startedAt: 0, endedAt: 2_000 }),
      turn({ sessionID: "a", turn: 3, startedAt: 0, endedAt: 9_000, firstTokenMs: 900 }),
    ])
    expect(report.sessions[0]!.turnMs).toEqual({ p50: 2_000, p95: 9_000 })
    expect(report.sessions[0]!.firstTokenMs).toEqual({ p50: 100, p95: 900 })
    expect(report.totals.turnMs).toEqual({ p50: 2_000, p95: 9_000 })
  })

  test("a session with no first token measured leaves the percentiles out rather than inventing zero", () => {
    const report = summariseSessions([turn({ sessionID: "a", turn: 1 })])
    expect(report.sessions[0]!.firstTokenMs).toEqual({})
  })

  test("tools are ranked by output bytes, per session and overall", () => {
    const report = summariseSessions([
      turn({
        sessionID: "a",
        turn: 1,
        tools: { read: { calls: 3, errors: 0, bytes: 9_000 }, bash: { calls: 1, errors: 1, bytes: 500 } },
      }),
      turn({ sessionID: "a", turn: 2, tools: { bash: { calls: 2, errors: 0, bytes: 12_000 } } }),
      turn({ sessionID: "b", turn: 1, tools: { grep: { calls: 1, errors: 0, bytes: 100 } } }),
    ])
    const a = report.sessions.find((session) => session.sessionID === "a")!
    expect(a.topTools).toEqual([
      { tool: "bash", calls: 3, errors: 1, bytes: 12_500 },
      { tool: "read", calls: 3, errors: 0, bytes: 9_000 },
    ])
    expect(report.topTools.map((tool) => tool.tool)).toEqual(["bash", "read", "grep"])
  })

  test("a session keeps its five biggest tools", () => {
    const tools = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`t${index}`, { calls: 1, errors: 0, bytes: index * 10 }]),
    )
    const report = summariseSessions([turn({ sessionID: "a", turn: 1, tools })])
    expect(report.sessions[0]!.topTools.map((tool) => tool.tool)).toEqual(["t7", "t6", "t5", "t4", "t3"])
  })

  test("the window and the project filter turns, and a session that spans the edge reports only its inside", () => {
    const turns = [
      turn({ sessionID: "a", turn: 1, endedAt: 500, projectID: "/w" }),
      turn({ sessionID: "a", turn: 2, endedAt: 5_000, projectID: "/w" }),
      turn({ sessionID: "b", turn: 1, endedAt: 6_000, projectID: "/other" }),
    ]
    const windowed = summariseSessions(turns, { since: 1_000 })
    expect(windowed.totals).toMatchObject({ sessions: 2, turns: 2 })
    expect(windowed.sessions.find((session) => session.sessionID === "a")!.turns).toBe(1)
    const project = summariseSessions(turns, { projectID: "/w" })
    expect(project.sessions.map((session) => session.sessionID)).toEqual(["a"])
  })

  test("the newest session comes first, and the limit cuts the list but not the totals", () => {
    const turns = [
      turn({ sessionID: "old", turn: 1, endedAt: 1_000 }),
      turn({ sessionID: "new", turn: 1, endedAt: 3_000 }),
      turn({ sessionID: "mid", turn: 1, endedAt: 2_000 }),
    ]
    const report = summariseSessions(turns, { limit: 2 })
    expect(report.sessions.map((session) => session.sessionID)).toEqual(["new", "mid"])
    expect(report.totals.sessions).toBe(3)
    expect(report.totals.cost).toBeCloseTo(0.03)
  })

  test("nothing measured is an empty report, not a page of NaN", () => {
    expect(summariseSessions([])).toEqual({
      totals: {
        sessions: 0,
        turns: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        cached: 0,
        turnMs: {},
        firstTokenMs: {},
      },
      sessions: [],
      topTools: [],
    })
  })

  test("the limit defaults, is capped, and a nonsense one falls back", () => {
    expect(clampLimit(undefined)).toBe(50)
    expect(clampLimit(0)).toBe(50)
    expect(clampLimit(10.7)).toBe(10)
    expect(clampLimit(10_000)).toBe(200)
  })
})

const step = (id: string, turnID: string, cacheRead = 1000): MetricObservation => ({
  kind: "step",
  id,
  turnID,
  providerID: "anthropic",
  modelID: "sonnet",
  tokens: { input: 100, output: 40, reasoning: 0, cacheRead, cacheWrite: 0 },
  cost: 0.02,
  ms: 800,
  firstTokenMs: 300,
})

const open = (options: HarnessHandlerOptions = { adaptiveToken: ADAPTIVE, token: BROWSER }) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const read = (query = "", token = BROWSER) =>
  new Request(`http://x/harness/adaptive/metrics/sessions${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

describe("listSessionMetricTurns", () => {
  test("reads every session in the window and the project", () => {
    const { repository } = open()
    repository.recordSessionMetric({ sessionID: "a", projectID: "/w", observation: step("s1", "u1") }, 1_000)
    repository.recordSessionMetric({ sessionID: "a", projectID: "/w", observation: step("s2", "u2") }, 5_000)
    repository.recordSessionMetric({ sessionID: "b", projectID: "/x", observation: step("s3", "u3") }, 6_000)
    expect(repository.listSessionMetricTurns()).toHaveLength(3)
    expect(repository.listSessionMetricTurns({ since: 4_000 }).map((row) => row.turnID).sort()).toEqual(["u2", "u3"])
    expect(repository.listSessionMetricTurns({ projectID: "/w" }).map((row) => row.sessionID)).toEqual(["a", "a"])
  })
})

describe("the session summary route", () => {
  test("answers every session in one read under the browser bearer", async () => {
    const { repository, handler } = open()
    repository.recordSessionMetric({ sessionID: "a", projectID: "/w", observation: step("s1", "u1") })
    repository.recordSessionMetric({ sessionID: "b", projectID: "/x", observation: step("s2", "u2", 0) })
    const response = await handler(read())
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { totals: { sessions: number }; sessions: { sessionID: string }[] } }
    expect(body.data.totals.sessions).toBe(2)
    const filtered = (await (await handler(read("?directory=%2Fw"))).json()) as typeof body
    expect(filtered.data.sessions.map((session) => session.sessionID)).toEqual(["a"])
  })

  test("the acting bearer, no bearer and a wrong one are refused", async () => {
    const { handler } = open()
    expect((await handler(read("", ADAPTIVE))).status).toBe(403)
    expect((await handler(read("", ""))).status).toBe(403)
    expect((await handler(read("", "nope"))).status).toBe(403)
  })

  test("a malformed window or limit is a 400", async () => {
    const { handler } = open()
    expect((await handler(read("?since=yesterday"))).status).toBe(400)
    expect((await handler(read("?limit=-3"))).status).toBe(400)
  })

  test("the single-session read still answers beside it", async () => {
    const { repository, handler } = open()
    repository.recordSessionMetric({ sessionID: "a", observation: step("s1", "u1") })
    const response = await handler(
      new Request("http://x/harness/adaptive/metrics?sessionID=a", { headers: { authorization: `Bearer ${BROWSER}` } }),
    )
    expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(1)
  })
})
