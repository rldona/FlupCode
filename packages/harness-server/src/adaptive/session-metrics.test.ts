/**
 * The per-turn cost baseline (AH-B01): the fold, the repository's once-only write and the route.
 *
 * The acceptance case is a five-turn session: five rows whose sums are the provider's own usage, to
 * the token, because the plugin forwards the engine's step usage untouched.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { armsFor } from "./holdout"
import { applyObservation, emptyTurn } from "./session-metrics"
import type { MetricObservation } from "./session-metrics"

const ADAPTIVE = "adaptive-secret"
const BROWSER = "browser-secret"

const step = (id: string, turnID: string, input: number, extra: Partial<MetricObservation> = {}): MetricObservation =>
  ({
    kind: "step",
    id,
    turnID,
    providerID: "anthropic",
    modelID: "sonnet",
    agent: "build",
    tokens: { input, output: 40, reasoning: 10, cacheRead: 1000, cacheWrite: 50 },
    cost: 0.02,
    ms: 800,
    firstTokenMs: 300,
    ...extra,
  }) as MetricObservation

const open = (options: HarnessHandlerOptions = { adaptiveToken: ADAPTIVE, token: BROWSER }) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const post = (body: unknown, token: string | undefined = ADAPTIVE) =>
  new Request("http://x/harness/adaptive/metrics", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const read = (sessionID: string, token: string | undefined = BROWSER) =>
  new Request(`http://x/harness/adaptive/metrics?sessionID=${sessionID}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

describe("applyObservation", () => {
  const turn = () => emptyTurn({ sessionID: "ses_1", turnID: "msg_u1", turn: 1, now: 10_000 })

  test("a step adds its usage, its cost and its time, and the first step names the first token", () => {
    const once = applyObservation(turn(), step("s1", "msg_u1", 100), 10_000)
    const twice = applyObservation(once, step("s2", "msg_u1", 200, { firstTokenMs: 90, modelID: "opus" }), 11_000)
    expect(twice).toMatchObject({
      requests: 2,
      tokens: { input: 300, output: 80, reasoning: 20, cacheRead: 2000, cacheWrite: 100 },
      modelMs: 1600,
      firstTokenMs: 300,
      modelID: "opus",
      startedAt: 9_200,
      endedAt: 11_000,
    })
    expect(twice.cost).toBeCloseTo(0.04)
  })

  test("a tool adds to its own line and a skill load is named once", () => {
    const tool = (id: string, name: string, bytes: number, error = false, skill?: string): MetricObservation => ({
      kind: "tool",
      id,
      turnID: "msg_u1",
      tool: name,
      error,
      bytes,
      ...(skill ? { skill } : {}),
    })
    const folded = [
      tool("t1", "read", 100),
      tool("t2", "read", 50),
      tool("t3", "bash", 0, true),
      tool("t4", "skill", 10, false, "testing"),
      tool("t5", "skill", 10, false, "testing"),
    ].reduce((current, observation) => applyObservation(current, observation, 10_000), turn())
    expect(folded).toMatchObject({
      toolCalls: 5,
      toolErrors: 1,
      toolOutputBytes: 170,
      tools: {
        read: { calls: 2, errors: 0, bytes: 150 },
        bash: { calls: 1, errors: 1, bytes: 0 },
        skill: { calls: 2, errors: 0, bytes: 20 },
      },
      skills: ["testing"],
    })
  })

  test("a compaction counts", () => {
    expect(applyObservation(turn(), { kind: "compaction", id: "c1", turnID: "msg_u1" }, 10_000).compactions).toBe(1)
  })

  test("a re-read after compaction counts, and a compaction step's output is the summary's size", () => {
    const reread = applyObservation(
      turn(),
      { kind: "tool", id: "t1", turnID: "msg_u1", tool: "read", error: false, bytes: 10, reread: true },
      10_000,
    )
    const plain = applyObservation(
      reread,
      { kind: "tool", id: "t2", turnID: "msg_u1", tool: "read", error: false, bytes: 10 },
      10_000,
    )
    const summary = applyObservation(plain, step("s1", "msg_u1", 100, { agent: "compaction" }), 10_000)
    const work = applyObservation(summary, step("s2", "msg_u1", 100), 10_000)
    expect(work).toMatchObject({ rereadsAfterCompaction: 1, summaryTokens: 40, toolCalls: 2 })
  })
})

describe("recordSessionMetric", () => {
  test("a five-turn session is five rows that add up to the provider's usage", () => {
    const { repository } = open()
    const inputs = [120, 340, 560, 780, 900]
    inputs.forEach((input, index) => {
      const turnID = `msg_u${index + 1}`
      expect(repository.recordSessionMetric({ sessionID: "ses_1", projectID: "/w", observation: step(`s${index}`, turnID, input) })).toBe(true)
      repository.recordSessionMetric({
        sessionID: "ses_1",
        observation: { kind: "tool", id: `t${index}`, turnID, tool: "read", error: false, bytes: 64 },
      })
    })

    const rows = repository.listSessionMetrics("ses_1")
    expect(rows.map((row) => row.turn)).toEqual([1, 2, 3, 4, 5])
    expect(rows.map((row) => row.tokens.input)).toEqual(inputs)
    expect(rows.every((row) => row.requests === 1 && row.toolCalls === 1 && row.projectID === "/w")).toBe(true)
    expect(rows.reduce((total, row) => total + row.tokens.input + row.tokens.output, 0)).toBe(2700 + 5 * 40)
  })

  test("the same observation twice is recorded once", () => {
    const { repository } = open()
    expect(repository.recordSessionMetric({ sessionID: "ses_1", observation: step("s1", "msg_u1", 100) })).toBe(true)
    expect(repository.recordSessionMetric({ sessionID: "ses_1", observation: step("s1", "msg_u1", 100) })).toBe(false)
    expect(repository.listSessionMetrics("ses_1")[0]!.requests).toBe(1)
  })

  test("the re-reads and the summary tokens survive the row", () => {
    const { repository } = open()
    repository.recordSessionMetric({
      sessionID: "ses_1",
      observation: { kind: "tool", id: "t1", turnID: "msg_u1", tool: "read", error: false, bytes: 1, reread: true },
    })
    repository.recordSessionMetric({ sessionID: "ses_1", observation: step("s1", "msg_u1", 100, { agent: "compaction" }) })
    expect(repository.listSessionMetrics("ses_1")[0]).toMatchObject({ rereadsAfterCompaction: 1, summaryTokens: 40 })
  })

  test("the dedupe ledger is pruned by age", () => {
    const { repository } = open()
    repository.recordSessionMetric({ sessionID: "ses_1", observation: step("s1", "msg_u1", 100) }, 1_000)
    expect(repository.pruneSessionMetricSeen(2_000)).toBe(1)
    expect(repository.listSessionMetrics("ses_1")).toHaveLength(1)
  })
})

describe("the metrics routes", () => {
  const body = { projectID: "/w", sessionID: "ses_1", observation: step("s1", "msg_u1", 100) }

  test("the plugin posts with the dedicated bearer and the browser reads with its own", async () => {
    const { handler } = open()
    const response = await handler(post(body))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { recorded: true } })
    expect(await (await handler(post(body))).json()).toEqual({ data: { recorded: false } })

    const listed = await handler(read("ses_1"))
    expect(listed.status).toBe(200)
    const rows = ((await listed.json()) as { data: Array<{ turn: number; tokens: { input: number } }> }).data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ turn: 1, tokens: { input: 100 } })
  })

  test("a tool's re-read flag travels, and anything but true is not one", async () => {
    const { handler, repository } = open()
    const tool = (id: string, reread: unknown) =>
      post({ sessionID: "ses_1", observation: { kind: "tool", id, turnID: "msg_u1", tool: "read", error: false, bytes: 1, reread } })
    await handler(tool("t1", true))
    await handler(tool("t2", "yes"))
    expect(repository.listSessionMetrics("ses_1")[0]).toMatchObject({ toolCalls: 2, rereadsAfterCompaction: 1 })
  })

  test("a new turn records the session's holdout arms", async () => {
    const { handler, repository } = open({ adaptiveToken: ADAPTIVE, token: BROWSER, holdoutFraction: () => 0.2 })
    await handler(post(body))
    expect(repository.listSessionMetrics("ses_1")[0]!.arms).toEqual(armsFor("ses_1", 0.2))
    // Without a holdout reader the row carries no arms rather than a guess.
    const bare = open()
    await bare.handler(post(body))
    expect(bare.repository.listSessionMetrics("ses_1")[0]!.arms).toBeUndefined()
  })

  test("the browser bearer cannot post and the acting bearer cannot read", async () => {
    const { handler } = open()
    expect((await handler(post(body, BROWSER))).status).toBe(403)
    expect((await handler(post(body, ""))).status).toBe(403)
    expect((await handler(read("ses_1", ADAPTIVE))).status).toBe(403)
  })

  test("without the dedicated token the post is not a route and is not announced", async () => {
    const { handler } = open({ token: BROWSER })
    expect((await handler(post(body))).status).toBe(404)
    const health = (await (await handler(new Request("http://x/harness/health"))).json()) as { capabilities: string[] }
    expect(health.capabilities).not.toContain("adaptive-metrics")
    const withToken = open()
    const announced = (await (await withToken.handler(new Request("http://x/harness/health"))).json()) as {
      capabilities: string[]
    }
    expect(announced.capabilities).toContain("adaptive-metrics")
  })

  test("a malformed body or observation is refused and records nothing", async () => {
    const { handler, repository } = open()
    const refused = [
      {},
      { ...body, sessionID: "" },
      { ...body, sessionID: "x".repeat(201) },
      { ...body, projectID: 7 },
      { ...body, observation: { kind: "prompt", id: "p", turnID: "u", text: "secret" } },
      { ...body, observation: { ...body.observation, tokens: { input: -1 } } },
      { ...body, observation: { kind: "tool", id: "t", turnID: "u", tool: "read", error: "no", bytes: 1 } },
      { ...body, observation: { kind: "step", id: "s", turnID: "u", tokens: body.observation, cost: Number.NaN, ms: 1 } },
    ]
    for (const candidate of refused) expect((await handler(post(candidate))).status).toBe(400)
    expect(repository.listSessionMetrics("ses_1")).toHaveLength(0)
    expect((await handler(read(""))).status).toBe(400)
  })
})
