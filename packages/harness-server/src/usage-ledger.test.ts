import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { MAX_USAGE_BATCH, type LedgerEvent, type ToolEvent } from "./usage-ledger"

const directories: string[] = []
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-ledger-"))
  directories.push(directory)
  return join(directory, "harness.sqlite")
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A step as the plugin reports it: every engine fact §8.4 names. */
const step = (id = "evt_step_1") => ({
  id,
  kind: "step" as const,
  sessionID: "ses_child",
  parentSessionID: "ses_parent",
  rootSessionID: "ses_root",
  messageID: "msg_1",
  turnID: "msg_user_1",
  engineSeq: 42,
  agent: "build",
  providerID: "anthropic",
  modelID: "claude-sonnet",
  variant: "high",
  tokens: { input: 1200, output: 340, reasoning: 80, cacheRead: 5000, cacheWrite: 600 },
  costUSD: 0.0123,
  costBasis: "engine-list-price" as const,
  billing: "metered" as const,
  startedAt: 1_000,
  endedAt: 3_500,
  firstTokenMs: 420,
  finish: "tool-calls",
  errorType: "none",
  retryAttempt: 1,
  directory: "/work/demo",
  engineProjectID: "prj_1",
})

const tool = (id = "evt_tool_1"): ToolEvent => ({
  id,
  sessionID: "ses_child",
  messageID: "msg_1",
  tool: "read",
  startedAt: 1_100,
  ms: 30,
  error: false,
  bytes: 2048,
})

/** What the server stamps on a fact later (UL-04). */
const attribution = {
  runID: "run_1",
  taskID: "task_1",
  attempt: 2,
  routineID: "rtn_1",
  workflowName: "feature",
  workflowHash: "abc123",
  purpose: "run-task" as const,
  tags: { team: "core" },
}

describe("the usage ledger (UL-01)", () => {
  test("stores a batch once, however many times it is posted", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const batch = { events: [step("a"), step("b")], tools: [tool("t1")] }
    expect(repository.recordUsage(batch)).toEqual({ events: 2, tools: 1 })
    expect(repository.recordUsage(batch)).toEqual({ events: 0, tools: 0 })
    expect(repository.recordUsage({ events: [step("b"), step("c")], tools: [tool("t1"), tool("t2")] })).toEqual({
      events: 1,
      tools: 1,
    })
    expect(repository.usageEvents("ses_child").map((event) => event.id)).toEqual(["a", "b", "c"])
    expect(repository.toolEvents("ses_child").map((event) => event.id)).toEqual(["t1", "t2"])
    repository.close()
  })

  test("a step event fills every column of §8.4", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const event: LedgerEvent = { ...step(), ...attribution }
    repository.recordUsage({ events: [event], tools: [tool()] })
    const row = repository.db.query("SELECT * FROM usage_event WHERE id = ?1").get(event.id) as Record<string, unknown>
    const columns = (repository.db.query("PRAGMA table_info(usage_event)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    )
    expect(columns.sort()).toEqual(
      [
        "id",
        "kind",
        "session_id",
        "parent_session_id",
        "root_session_id",
        "message_id",
        "turn_id",
        "engine_seq",
        "agent",
        "provider_id",
        "model_id",
        "variant",
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
        "cost_usd",
        "cost_basis",
        "billing",
        "started_at",
        "ended_at",
        "first_token_ms",
        "finish",
        "error_type",
        "retry_attempt",
        "directory",
        "engine_project_id",
        "run_id",
        "task_id",
        "attempt",
        "routine_id",
        "workflow_name",
        "workflow_hash",
        "purpose",
        "tags_json",
      ].sort(),
    )
    expect(columns.filter((column) => row[column] === null || row[column] === undefined)).toEqual([])
    expect(row).toMatchObject({
      tokens_cache_read: 5000,
      cost_usd: 0.0123,
      tags_json: '{"team":"core"}',
      engine_seq: 42,
    })
    // Read back, the row is the fact that went in.
    expect(repository.usageEvents("ses_child")).toEqual([event])
    const toolColumns = (repository.db.query("PRAGMA table_info(tool_event)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    )
    expect(toolColumns.sort()).toEqual(["bytes", "error", "id", "message_id", "ms", "session_id", "started_at", "tool"])
    expect(repository.toolEvents("ses_child")).toEqual([tool()])
    repository.close()
  })

  test("an unpriced fact keeps no cost rather than a zero", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const { costUSD: _, ...unpriced } = { ...step("local"), costBasis: "unpriced" as const, billing: "local" as const }
    repository.recordUsage({ events: [unpriced], tools: [] })
    expect(repository.db.query("SELECT cost_usd FROM usage_event WHERE id = 'local'").get()).toEqual({ cost_usd: null })
    expect(repository.usageEvents("ses_child")[0]?.costUSD).toBeUndefined()
    repository.close()
  })

  test("a database from before the ledger is backed up and migrated with everything it held", () => {
    const path = scratch()
    const before = new SqliteRoutineRepository(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    before.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    before.finishRun(run.id, "success", undefined, 2_000)
    before.db.exec(`
      DELETE FROM schema_version WHERE version >= 5;
      DROP TABLE usage_event;
      DROP TABLE tool_event;
    `)
    before.close()

    const repository = new SqliteRoutineRepository(path)
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".bak-v"))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^harness\.sqlite\.bak-v4-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 5").all()).toEqual([
      { version: 5, name: "usage-ledger" },
    ])
    expect(repository.getRun(run.id)).toMatchObject({ id: run.id, status: "success" })
    expect(repository.listTasks(run.id).map((task) => task.name)).toEqual(["plan"])
    expect(repository.recordUsage({ events: [step()], tools: [tool()] })).toEqual({ events: 1, tools: 1 })
    const copy = new Database(join(dirname(path), backups[0]!))
    expect((copy.query("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})

describe("POST /harness/usage/events (UL-01)", () => {
  const ingest = () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
    const post = (token: string, body: unknown) =>
      handler(
        new Request("http://127.0.0.1:4097/harness/usage/events", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      )
    return { repository, post }
  }

  test("the plugin's token writes; the app's token and no token do not", async () => {
    const { repository, post } = ingest()
    expect((await post("ui-token", { events: [step()] })).status).toBe(403)
    expect((await post("", { events: [step()] })).status).toBe(403)
    expect(repository.usageEvents("ses_child")).toEqual([])
    const response = await post("plugin-token", { events: [step()], tools: [tool()] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { stored: { events: 1, tools: 1 }, rejected: [] } })
    repository.close()
  })

  test("the same batch posted twice is stored once", async () => {
    const { repository, post } = ingest()
    const batch = { events: [step("a"), step("b")], tools: [tool()] }
    await post("plugin-token", batch)
    const again = (await (await post("plugin-token", batch)).json()) as { data: { stored: unknown } }
    expect(again.data.stored).toEqual({ events: 0, tools: 0 })
    expect(repository.usageEvents("ses_child")).toHaveLength(2)
    repository.close()
  })

  test("attribution is the server's: a caller's run, task or purpose is not stored", async () => {
    const { repository, post } = ingest()
    await post("plugin-token", { events: [{ ...step(), ...attribution }] })
    expect(repository.usageEvents("ses_child")).toEqual([step()])
    repository.close()
  })

  test("a batch over the limit is refused whole; a bad item is named and the rest kept", async () => {
    const { repository, post } = ingest()
    const many = Array.from({ length: MAX_USAGE_BATCH + 1 }, (_, index) => step(`e${index}`))
    const over = await post("plugin-token", { events: many })
    expect(over.status).toBe(413)
    expect(((await over.json()) as { code: string }).code).toBe("batch_too_large")
    expect(
      (await post("plugin-token", { tools: Array.from({ length: MAX_USAGE_BATCH + 1 }, (_, i) => tool(`t${i}`)) }))
        .status,
    ).toBe(413)
    expect(repository.usageEvents("ses_child")).toEqual([])

    expect(
      (
        await post(
          "plugin-token",
          Array.from({ length: MAX_USAGE_BATCH }, (_, index) => step(`e${index}`)),
        )
      ).status,
    ).toBe(400)
    expect((await post("plugin-token", "not json")).status).toBe(400)
    expect((await post("plugin-token", { events: "nope" })).status).toBe(400)

    const response = await post("plugin-token", {
      events: [
        step("good"),
        { ...step("bad"), kind: "mystery" },
        { ...step("neg"), tokens: { ...step().tokens, input: -1 } },
      ],
      tools: [tool(), { ...tool("t2"), error: "no" }],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        stored: { events: 1, tools: 1 },
        rejected: [
          { list: "events", index: 1, error: expect.stringContaining("kind must be one of") },
          { list: "events", index: 2, error: expect.stringContaining("tokens") },
          { list: "tools", index: 1, error: "error must be a boolean" },
        ],
      },
    })
    expect(repository.usageEvents("ses_child").map((event) => event.id)).toEqual(["good"])
    // A full batch, at the limit, is accepted.
    const full = await post("plugin-token", {
      events: Array.from({ length: MAX_USAGE_BATCH }, (_, index) => step(`f${index}`)),
    })
    expect(((await full.json()) as { data: { stored: { events: number } } }).data.stored.events).toBe(MAX_USAGE_BATCH)
    repository.close()
  })
})
