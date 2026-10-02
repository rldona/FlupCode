import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { RunWorkflow } from "./types"
import { handleUsageRead, summariseUsage, USAGE_DIMENSIONS, type UsageBucket, type UsageDimension } from "./usage"
import type { LedgerEvent, UsageTokens } from "./usage-ledger"

/**
 * The usage summary (UL-05) on a fixture ledger: every dimension of audit §8.4 adds up to the
 * ungrouped total, unpriced rows are counted as unpriced and never as $0, and a session or a run
 * reads back as the sum of its parts.
 */

const day = (date: number, hour = 12) => new Date(2026, 8, date, hour, 0, 0).getTime()
const tokens = (input: number, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0): UsageTokens => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite,
})
const workflow: RunWorkflow = { name: "feature", scope: "project", hash: "sha256-feature", inputs: {} }

let counter = 0
const event = (sessionID: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: `${sessionID}:step:${++counter}`,
  kind: "step",
  sessionID,
  agent: "build",
  providerID: "anthropic",
  modelID: "sonnet",
  variant: "default",
  tokens: tokens(100, 20, 5, 1000, 50),
  costUSD: 0.1,
  costBasis: "engine-list-price",
  billing: "metered",
  startedAt: day(10) - 1000,
  endedAt: day(10),
  directory: "/work/a",
  ...extra,
})

/**
 * A chat with a subagent, a routine's workflow run with two tasks (one a retry) and a handoff on a
 * local model nobody priced, a Copilot step billed by subscription, a tagged row, and a row whose
 * basis claims a price but whose cost is missing.
 */
function fixture() {
  const repository = new SqliteRoutineRepository(":memory:")
  const run = repository.startRun({ type: "manual" }, day(11), "/work/b", { workflow })
  const [first, retry] = repository.addTasks(run.id, [
    { name: "write", prompt: "p" },
    { name: "write", prompt: "p", attempt: 2 },
  ])
  repository.attributeSession("ses_chat", { purpose: "chat", directory: "/work/a" })
  // A subagent as the ingest learns it from the engine: its parent, nothing else.
  repository.attributeSession("ses_sub", { parentSessionID: "ses_chat" }, "engine")
  repository.attributeSession("ses_t1", { runID: run.id, taskID: first!.id, purpose: "run-task", routineID: "rtn_1" })
  repository.attributeSession("ses_t2", { runID: run.id, taskID: retry!.id, purpose: "run-task", routineID: "rtn_1" })
  repository.attributeSession("ses_handoff", { runID: run.id, purpose: "handoff", routineID: "rtn_1" })
  repository.recordUsage({
    events: [
      event("ses_chat"),
      event("ses_chat", { kind: "title", agent: undefined, costUSD: 0.01, tokens: tokens(30, 5) }),
      event("ses_sub", { parentSessionID: "ses_chat", agent: "explore", costUSD: 0.05 }),
      event("ses_subsub", { parentSessionID: "ses_sub", agent: "explore", costUSD: 0.02, tags: { feature: "login" } }),
      event("ses_t1", {
        providerID: "github-copilot",
        modelID: "gpt-5",
        billing: "subscription",
        costUSD: 0.3,
        endedAt: day(11),
      }),
      event("ses_t2", { costUSD: 0.2, endedAt: day(11), tags: { feature: "login" } }),
      event("ses_t2", { kind: "compaction", costUSD: 0.04, endedAt: undefined, startedAt: day(11) }),
      event("ses_handoff", {
        providerID: "local",
        modelID: "llama",
        costUSD: undefined,
        costBasis: "unpriced",
        billing: "local",
        tokens: tokens(500, 100),
        endedAt: day(12),
      }),
      // A basis that names a price with no cost behind it is still unpriced.
      event("ses_chat", { costUSD: undefined, tokens: tokens(7), endedAt: day(12) }),
    ],
    tools: [],
  })
  return { repository, run, first: first!, retry: retry! }
}

/** Every group plus the rest, added up the way a reader would: it must give the total back. */
function sumOf(buckets: UsageBucket[]) {
  const sum = {
    events: 0,
    tokens: tokens(0),
    usd: new Map<string, number>(),
    unpricedEvents: 0,
    unpricedTokens: tokens(0),
  }
  const add = (into: UsageTokens, from: UsageTokens) => {
    for (const key of Object.keys(into) as Array<keyof UsageTokens>) into[key] += from[key]
  }
  for (const bucket of buckets) {
    sum.events += bucket.events
    add(sum.tokens, bucket.tokens)
    sum.unpricedEvents += bucket.unpriced.events
    add(sum.unpricedTokens, bucket.unpriced.tokens)
    for (const line of bucket.money) {
      const key = `${line.basis}/${line.billing}`
      sum.usd.set(key, (sum.usd.get(key) ?? 0) + line.usd)
    }
  }
  return {
    ...sum,
    usd: Object.fromEntries([...sum.usd.entries()].map(([key, usd]) => [key, Math.round(usd * 1e9) / 1e9]).sort()),
  }
}

const summary = (repository: SqliteRoutineRepository, groupBy?: UsageDimension, extra: Record<string, string> = {}) => {
  const search = new URLSearchParams({ ...(groupBy ? { groupBy } : {}), ...extra })
  const response = handleUsageRead(
    new Request(`http://127.0.0.1/harness/usage/summary?${search}`),
    ["harness", "usage", "summary"],
    repository,
  )!
  return response.json().then((body) => body.data)
}

describe("the usage summary (UL-05)", () => {
  test.each(USAGE_DIMENSIONS.map((dimension) => [dimension]))(
    "grouped by %s, the groups add up to the ungrouped total",
    async (dimension) => {
      const { repository } = fixture()
      const total = (await summary(repository)).total
      const grouped = await summary(repository, dimension, dimension === "tag" ? { tag: "feature" } : {})
      expect(grouped.total).toEqual(total)
      expect(sumOf([...grouped.groups, ...(grouped.rest ? [grouped.rest] : [])])).toEqual(sumOf([total]))
      repository.close()
    },
  )

  test("the total keeps money apart by basis and billing, and unpriced rows out of it", async () => {
    const { repository } = fixture()
    const total = (await summary(repository)).total
    expect(total.events).toBe(9)
    expect(total.money).toEqual([
      { basis: "engine-list-price", billing: "metered", usd: expect.closeTo(0.42, 9), events: 6 },
      { basis: "engine-list-price", billing: "subscription", usd: expect.closeTo(0.3, 9), events: 1 },
    ])
    // The local handoff and the row with no cost: counted, with their tokens, and no money at all.
    expect(total.unpriced).toEqual({ events: 2, tokens: tokens(507, 100) })
    repository.close()
  })

  test("an unpriced group has no money line, never a $0 one", async () => {
    const { repository } = fixture()
    const groups = (await summary(repository, "model")).groups
    const llama = groups.find((group: { key: string }) => group.key === "local/llama/default")
    expect(llama).toMatchObject({
      money: [],
      unpriced: { events: 1 },
      fields: { providerID: "local", modelID: "llama", variant: "default" },
    })
    repository.close()
  })

  test("by run, the chat's rows are a group of their own and the run's carry its id", async () => {
    const { repository, run } = fixture()
    const groups = (await summary(repository, "run")).groups
    expect(groups.map((group: { key: string | null; events: number }) => [group.key, group.events])).toEqual([
      [run.id, 4],
      [null, 5],
    ])
    repository.close()
  })

  test("by task, each attempt is its own group", async () => {
    const { repository, run, first, retry } = fixture()
    const groups = (await summary(repository, "task")).groups
    expect(
      groups
        .filter((group: { key: string | null }) => group.key !== null)
        .map((group: { fields: unknown }) => group.fields),
    ).toEqual([
      { taskID: first.id, runID: run.id, attempt: 1 },
      { taskID: retry.id, runID: run.id, attempt: 2 },
    ])
    repository.close()
  })

  test("by workflow and routine, a run's rows carry what it ran and who asked", async () => {
    const { repository } = fixture()
    const workflows = (await summary(repository, "workflow")).groups
    expect(workflows.map((group: { key: string | null }) => group.key)).toEqual(["feature@sha256-feature", null])
    const routines = (await summary(repository, "routine")).groups
    expect(routines.map((group: { key: string | null; events: number }) => [group.key, group.events])).toEqual([
      ["rtn_1", 4],
      [null, 5],
    ])
    repository.close()
  })

  test("by purpose, the harness's own spending is told apart", async () => {
    const { repository } = fixture()
    const groups = (await summary(repository, "purpose")).groups
    expect(
      Object.fromEntries(groups.map((group: { key: string; events: number }) => [group.key, group.events])),
    ).toEqual({
      chat: 4,
      title: 1,
      "run-task": 2,
      compaction: 1,
      handoff: 1,
    })
    repository.close()
  })

  test("by session, a subagent's rows are folded onto the session its tree starts from", async () => {
    const { repository } = fixture()
    const groups = (await summary(repository, "session")).groups
    const chat = groups.find((group: { key: string }) => group.key === "ses_chat")
    expect(chat.fields).toEqual({ sessionID: "ses_chat", sessions: 3 })
    expect(chat.events).toBe(5)
    expect(chat.money).toEqual([
      { basis: "engine-list-price", billing: "metered", usd: expect.closeTo(0.18, 9), events: 4 },
    ])
    expect(groups.some((group: { key: string }) => group.key === "ses_sub")).toBe(false)
    repository.close()
  })

  test("by tag, one named tag: a row falls in one group, untagged rows in none", async () => {
    const { repository } = fixture()
    const groups = (await summary(repository, "tag", { tag: "feature" })).groups
    expect(groups.map((group: { key: string | null; events: number }) => [group.key, group.events])).toEqual([
      [null, 7],
      ["login", 2],
    ])
    repository.close()
  })

  test("by day, oldest first, the day a fact ended (or started, when it has no end)", async () => {
    const { repository } = fixture()
    const groups = (await summary(repository, "day")).groups
    expect(groups.map((group: { key: string; events: number }) => [group.key, group.events])).toEqual([
      ["2026-09-10", 4],
      ["2026-09-11", 3],
      ["2026-09-12", 2],
    ])
    repository.close()
  })

  test("from, to and directory narrow the rows; a worktree's folder reads as its repository", async () => {
    const { repository } = fixture()
    const window = await summary(repository, undefined, { from: String(day(11)), to: String(day(12)) })
    expect(window.total.events).toBe(3)
    const folder = await summary(repository, undefined, { directory: "/work/a" })
    expect(folder.total.events).toBe(5)
    repository.close()
  })

  test("the limit cuts the smallest groups into the rest, which keeps the sum whole", async () => {
    const { repository } = fixture()
    const all = await summary(repository, "session")
    const cut = await summary(repository, "session", { limit: "1" })
    expect(cut.groups).toEqual(all.groups.slice(0, 1))
    expect(cut.rest.groups).toBe(all.groups.length - 1)
    expect(sumOf([...cut.groups, cut.rest])).toEqual(sumOf([all.total]))
    repository.close()
  })

  test("refuses a dimension it does not know, a tag group without a tag and a bad number", async () => {
    const { repository } = fixture()
    const status = (query: string) =>
      handleUsageRead(
        new Request(`http://127.0.0.1/harness/usage/summary?${query}`),
        ["harness", "usage", "summary"],
        repository,
      )!.status
    expect(status("groupBy=colour")).toBe(400)
    expect(status("groupBy=tag")).toBe(400)
    expect(status("from=yesterday")).toBe(400)
    expect(status("limit=-1")).toBe(400)
    repository.close()
  })

  test("summariseUsage over no rows claims nothing", () => {
    expect(summariseUsage([], { groupBy: "agent" })).toEqual({
      groupBy: "agent",
      total: { events: 0, tokens: tokens(0), money: [], unpriced: { events: 0, tokens: tokens(0) } },
      groups: [],
    })
  })
})

describe("the session and run rollups (UL-05)", () => {
  const read = (repository: SqliteRoutineRepository, path: string[]) =>
    handleUsageRead(new Request(`http://127.0.0.1/${path.join("/")}`), path, repository)!

  test("a session is itself plus every subagent under it, and its parts add up to it", async () => {
    const { repository } = fixture()
    const report = (await read(repository, ["harness", "usage", "sessions", "ses_chat"]).json()).data
    expect(
      report.sessions.map((member: { sessionID: string; parentSessionID: string | null; depth: number }) => [
        member.sessionID,
        member.parentSessionID,
        member.depth,
      ]),
    ).toEqual([
      ["ses_chat", null, 0],
      ["ses_sub", "ses_chat", 1],
      ["ses_subsub", "ses_sub", 2],
    ])
    expect(sumOf(report.sessions)).toEqual(sumOf([report.total]))
    expect(sumOf(report.byAgent)).toEqual(sumOf([report.total]))
    // The engine's cost of a parent leaves its children out, so the tree's sum counts nothing twice.
    expect(sumOf([report.own]).usd).toEqual({ "engine-list-price/metered": 0.11 })
    expect(sumOf([report.total]).usd).toEqual({ "engine-list-price/metered": 0.18 })
    expect(report.own.unpriced.events).toBe(1)
    // The summary by session gives the same figure for the same tree.
    const bySession = (await summary(repository, "session")).groups.find(
      (group: { key: string }) => group.key === "ses_chat",
    )
    expect(sumOf([bySession])).toEqual(sumOf([report.total]))
    repository.close()
  })

  test("a subagent asked for alone is its own tree", async () => {
    const { repository } = fixture()
    const report = (await read(repository, ["harness", "usage", "sessions", "ses_sub"]).json()).data
    expect(report.sessions.map((member: { sessionID: string }) => member.sessionID)).toEqual(["ses_sub", "ses_subsub"])
    expect(sumOf([report.total]).usd).toEqual({ "engine-list-price/metered": 0.07 })
    repository.close()
  })

  test("a session with no rows answers with nothing measured, not $0", async () => {
    const { repository } = fixture()
    const report = (await read(repository, ["harness", "usage", "sessions", "ses_unknown"]).json()).data
    expect(report).toMatchObject({ total: { events: 0, money: [] }, sessions: [], byAgent: [] })
    repository.close()
  })

  test("a run is its tasks, its handoff and its overhead; each breakdown adds up to the same total", async () => {
    const { repository, run, first, retry } = fixture()
    const report = (await read(repository, ["harness", "usage", "runs", run.id]).json()).data
    expect(report.total.events).toBe(4)
    for (const breakdown of [report.byTask, report.byPurpose, report.byAgent, report.byModel])
      expect(sumOf(breakdown)).toEqual(sumOf([report.total]))
    expect(report.byTask.map((group: { key: string | null; events: number }) => [group.key, group.events])).toEqual([
      [first.id, 1],
      [retry.id, 2],
      [null, 1],
    ])
    expect(report.byPurpose.find((group: { key: string }) => group.key === "handoff")).toMatchObject({
      money: [],
      unpriced: { events: 1 },
    })
    // The run's figure in the summary is the same.
    const byRun = (await summary(repository, "run")).groups.find((group: { key: string }) => group.key === run.id)
    expect(sumOf([byRun])).toEqual(sumOf([report.total]))
    repository.close()
  })

  test("a run nobody knows is a 404", () => {
    const { repository } = fixture()
    expect(read(repository, ["harness", "usage", "runs", "run_missing"]).status).toBe(404)
    repository.close()
  })
})

describe("the usage read routes (UL-05)", () => {
  test("take the UI's bearer and refuse the plugins'", async () => {
    const { repository, run } = fixture()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
    const get = (path: string, token: string) =>
      handler(new Request(`http://127.0.0.1:4097${path}`, { headers: { authorization: `Bearer ${token}` } }))
    for (const path of [
      "/harness/usage/summary?groupBy=agent",
      "/harness/usage/sessions/ses_chat",
      `/harness/usage/runs/${run.id}`,
    ]) {
      expect((await get(path, "plugin-token")).status).toBe(403)
      expect((await get(path, "")).status).toBe(403)
      expect((await get(path, "ui-token")).status).toBe(200)
    }
    // The adaptive per-session costs stay for the screen that reads them, marked as replaced.
    const old = await get("/harness/adaptive/metrics/sessions", "ui-token")
    expect(old.status).toBe(200)
    expect(old.headers.get("deprecation")).toBe("true")
    expect(old.headers.get("link")).toBe('</harness/usage/summary?groupBy=session>; rel="successor-version"')
    repository.close()
  })
})
