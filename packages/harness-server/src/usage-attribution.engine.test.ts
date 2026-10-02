import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { RunWorkflow } from "./types"

/**
 * Attribution against the pinned OpenCode 2 engine (UL-04): a workflow run of two tasks, the first
 * of which hands work to a subagent, each followed by its closing note; and a chat opened on the
 * engine directly. The ledger is fed one row per engine session carrying the engine's own
 * `SessionInfo.cost`, through the real ingest route, standing in for the capture paths (UL-02,
 * UL-03): what is under test is who each row is billed to. Run it as CI's engine job does:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/usage-attribution.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const workflow: RunWorkflow = { name: "feature", scope: "project", hash: "sha256-feature", inputs: {} }
let contract: ContractEngine

beforeAll(async () => {
  if (!run) return
  // Priced, so every call costs something and a sum that leaves a session out shows.
  contract = await startEngine({ modelUrl: model.url, price: { input: 1000, output: 2000 } })
}, 120_000)

beforeEach(() => model.reset())

afterAll(async () => {
  await contract?.stop()
  model.stop()
})

describe.skipIf(!run)("usage attribution on an OpenCode 2 engine", () => {
  test("a workflow run's cost is its tasks, their subagents and its closing notes, each labelled", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: contract.url, authorization: contract.authorization })
    const handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
    model.push(
      // plan: hands the work to a subagent, which answers, then plan answers; then its closing note.
      { type: "tool", name: "subagent", input: { agent: "general", description: "Look around", prompt: "Look around" } },
      { type: "text", text: "Looked around" },
      { type: "text", text: "Plan: build it" },
      { type: "text", text: "Decided: build it" },
      // build, and its closing note.
      { type: "text", text: "Built it" },
      { type: "text", text: "Decided: built" },
    )
    const started = await scheduler.runTasks({
      tasks: [
        { name: "plan", prompt: "Plan it" },
        { name: "build", prompt: "Build it", dependsOn: ["plan"] },
      ],
      directory: contract.project,
      workflow,
    })
    await until(() => repository.getRun(started.id)?.status === "success" || undefined, 60_000)

    // A chat: a session a person opened on the engine, which the server never saw created.
    const chat = ((await call("POST", "/api/session", {})) as { data: SessionInfo }).data.id
    model.push({ type: "text", text: "Hello" })
    await call("POST", `/api/session/${chat}/prompt`, { text: "Hi" })
    await until(async () => (await get(chat)).time?.idle || undefined)

    // One row per engine session, through the ingest route the plugin uses.
    const sessions = ((await call("GET", "/api/session")) as { data: SessionInfo[] }).data
    const ingested = await handler(
      new Request("http://127.0.0.1/harness/usage/events", {
        method: "POST",
        headers: { authorization: "Bearer plugin-token", "content-type": "application/json" },
        body: JSON.stringify({
          events: sessions.map((session) => ({
            id: `${session.id}:total`,
            kind: "step",
            sessionID: session.id,
            tokens: { input: session.tokens.input, output: session.tokens.output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            costUSD: session.cost,
            costBasis: "engine-list-price",
            billing: "metered",
          })),
        }),
      }),
    )
    expect(ingested.status).toBe(200)

    // The run's sessions, as the engine and the run record them, without asking the ledger.
    const thread = repository.getRun(started.id)!.sessionID!
    const tasks = repository.listTasks(started.id)
    const [plan, build] = tasks
    const subagents = sessions.filter((session) => session.parentID === plan!.sessionID)
    const notes = sessions.filter((session) => tasks.some((task) => session.title === `${task.name} — handoff`))
    expect(subagents).toHaveLength(1)
    expect(notes).toHaveLength(2)
    const runSessions = [thread, ...tasks.map((task) => task.sessionID!), ...subagents.map((s) => s.id), ...notes.map((s) => s.id)]
    const engineCost = sessions
      .filter((session) => runSessions.includes(session.id))
      .reduce((sum, session) => sum + session.cost, 0)
    expect(engineCost).toBeGreaterThan(0)

    // The run's cost in the ledger is exactly that, and no row of a run session lacks the run.
    const ledger = repository.db
      .query("SELECT SUM(cost_usd) AS cost FROM usage_event WHERE run_id = ?1")
      .get(started.id) as { cost: number }
    expect(ledger.cost).toBeCloseTo(engineCost, 10)
    const placeholders = runSessions.map(() => "?").join(", ")
    expect(
      repository.db
        .query(`SELECT COUNT(*) AS count FROM usage_event WHERE session_id IN (${placeholders}) AND run_id IS NULL`)
        .get(...runSessions),
    ).toEqual({ count: 0 })

    // Each labelled by what it was.
    const row = (sessionID: string) => repository.usageEvents(sessionID)[0]
    const stamp = { runID: started.id, workflowName: "feature", workflowHash: "sha256-feature" }
    expect(row(plan!.sessionID!)).toMatchObject({ ...stamp, taskID: plan!.id, attempt: 1, purpose: "run-task" })
    expect(row(build!.sessionID!)).toMatchObject({ ...stamp, taskID: build!.id, purpose: "run-task" })
    expect(row(subagents[0]!.id)).toMatchObject({ ...stamp, taskID: plan!.id, purpose: "run-task" })
    for (const note of notes) expect(row(note.id)).toMatchObject({ ...stamp, purpose: "handoff" })
    expect(notes.map((note) => row(note.id)?.taskID).sort()).toEqual(tasks.map((task) => task.id).sort())
    expect(row(chat)).toMatchObject({ purpose: "chat", directory: contract.project })
    expect(row(chat)?.runID).toBeUndefined()

    // And everything the engine billed is in the ledger once: the run plus the chat.
    const total = repository.db.query("SELECT SUM(cost_usd) AS cost FROM usage_event").get() as { cost: number }
    expect(total.cost).toBeCloseTo(sessions.reduce((sum, session) => sum + session.cost, 0), 10)
    expect(total.cost).toBeCloseTo(engineCost + (await get(chat)).cost, 10)
    repository.close()
  }, 90_000)
})

type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  cost: number
  tokens: { input: number; output: number }
  time?: { idle?: number }
}

async function get(sessionID: string) {
  return ((await call("GET", `/api/session/${sessionID}`)) as { data: SessionInfo }).data
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${contract.url}${path}`, {
    method,
    headers: {
      authorization: contract.authorization,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(contract.project),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return response.json() as Promise<unknown>
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(50)
  }
}
