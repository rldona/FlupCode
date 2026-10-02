import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { recordEvents } from "@flupcode/engine-contract/events"
import { startModel } from "@flupcode/engine-contract/model"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * The usage ledger fed by the session-metrics plugin (UL-02), end to end: the pinned OpenCode 2
 * engine with FlupCode's plugins, a priced stub model, and harness-server's real ingest route and
 * repository. One session generates its title, runs a tool, fails a step and is compacted; its rows
 * are checked against what the engine's message.list says, the same source the reconciler (UL-03)
 * reads. Then the harness goes away for 30 seconds and nothing is lost. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/usage-ledger.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
// Every stub reply, the title's included, reports 10 input and 5 output tokens.
const PRICE = { input: 3, output: 15 }
const REPLY_COST = (10 * PRICE.input + 5 * PRICE.output) / 1_000_000
const model = startModel()
let engine: Engine
let repository: SqliteRoutineRepository
let handler: ReturnType<typeof createHarnessHandler>
let server: ReturnType<typeof Bun.serve>
let stream: ReturnType<typeof recordEvents>
let sessionID = ""

type Message = {
  id: string
  type: string
  cost?: number
  finish?: string
  content?: Array<{ type: string; id?: string; name?: string; time?: { ran?: number; completed?: number } }>
}

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  server = serve()
  engine = await startEngine({
    modelUrl: model.url,
    price: PRICE,
    env: {
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${server.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    prepare: async (home) => void (await installEnginePlugins(join(home, ".config", "opencode"))),
  })
  const scheduler = new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization })
  handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
  stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
  await stream.opened
  sessionID = ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id

  model.push(
    { type: "tool", name: "shell", input: { command: "echo hi", description: "Say hi" } },
    { type: "text", text: "Done" },
  )
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "go" })
  await settled("session.execution.succeeded", 1)

  model.push({ type: "error", status: 400, message: "Bad request from provider" })
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "fail" })
  await settled("session.execution.failed", 1)

  // A summary with one of the template's headings is one 2.0.18 accepts.
  model.push({ type: "text", text: "## Objective\nTest the ledger\n\n## Next Move\nNothing" })
  await call("POST", `/api/session/${sessionID}/compact`, {})
  await settled("session.compaction.ended", 1)
  await until(() => repository.usageEvents(sessionID).length >= 4 && repository.toolEvents(sessionID).length >= 1)
}, 180_000)

afterAll(async () => {
  stream?.close()
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the usage ledger on an OpenCode 2 engine", () => {
  test("a step, a failed step, a compaction and a tool each make one row, keyed as message.list names them", async () => {
    const messages = await list()
    const assistants = messages.filter((message) => message.type === "assistant")
    const compaction = messages.find((message) => message.type === "compaction")!
    const part = assistants.flatMap((message) => message.content ?? []).find((item) => item.type === "tool")!
    const rows = repository.usageEvents(sessionID)
    expect(rows.map((row) => row.id).sort()).toEqual(
      [
        ...assistants.map((message) =>
          message.finish === "error" ? `${sessionID}:step_failed:${message.id}` : `${sessionID}:step:${message.id}`,
        ),
        `${sessionID}:compaction:${compaction.id}`,
      ].sort(),
    )
    expect(rows.map((row) => row.kind).sort()).toEqual(["compaction", "step", "step", "step_failed"])
    // Each row carries the engine's sequence, and a step's cost is its message's.
    expect(rows.every((row) => typeof row.engineSeq === "number")).toBe(true)
    for (const message of assistants.filter((item) => item.finish !== "error"))
      expect(rows.find((row) => row.messageID === message.id)).toMatchObject({
        costUSD: message.cost,
        providerID: "stub",
        modelID: "stub-model",
        agent: "build",
        costBasis: "engine-list-price",
      })
    // 2.0.18 reports no cost for a step the provider refused.
    expect(rows.find((row) => row.kind === "step_failed")).toMatchObject({ errorType: "provider.invalid-request" })
    expect(rows.find((row) => row.kind === "step_failed")).not.toHaveProperty("costUSD")
    expect(rows.find((row) => row.kind === "compaction")).toMatchObject({
      costUSD: compaction.cost,
      messageID: compaction.id,
    })
    expect(repository.toolEvents(sessionID)).toEqual([
      expect.objectContaining({
        id: `${sessionID}:tool:${part.id}`,
        tool: "shell",
        error: false,
        startedAt: part.time!.ran,
        ms: part.time!.completed! - part.time!.ran!,
      }),
    ])
  })

  test("the rows add up to the session's cost, less the title the plugins cannot see", async () => {
    const session = (await call("GET", `/api/session/${sessionID}`)) as { data: { cost: number } }
    const ledger = repository.usageEvents(sessionID).reduce((total, row) => total + (row.costUSD ?? 0), 0)
    // Two steps and one compaction: the compaction's model call is no step of its own.
    expect(ledger).toBeCloseTo(3 * REPLY_COST, 12)
    expect(ledger).toBeCloseTo(session.data.cost - REPLY_COST, 12)
    // session.usage.recorded, the title's and the compaction's, reaches no subscriber on 2.0.18.
    expect(stream.events.some((event) => event.type === "session.usage.recorded")).toBe(false)
  })

  test("with the harness down for 30 seconds, every row arrives once it is back", async () => {
    const before = repository.usageEvents(sessionID).length
    const port = server.port
    server.stop(true)
    model.push(
      { type: "tool", name: "shell", input: { command: "echo again", description: "Again" } },
      { type: "text", text: "Done again" },
    )
    await call("POST", `/api/session/${sessionID}/prompt`, { text: "again" })
    await settled("session.execution.succeeded", 2)
    await Bun.sleep(30_000)
    expect(repository.usageEvents(sessionID)).toHaveLength(before)
    server = serve(port)
    await until(
      () => repository.usageEvents(sessionID).length === before + 2 && repository.toolEvents(sessionID).length === 2,
      30_000,
    )
    expect(repository.usageEvents(sessionID)).toHaveLength(before + 2)
    expect(repository.toolEvents(sessionID)).toHaveLength(2)
  }, 120_000)
})

/** harness-server's API on loopback, on a given port when it comes back. */
function serve(port = 0) {
  return Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => handler(request) })
}

async function settled(type: string, count: number) {
  await until(
    () => stream.events.filter((event) => event.type === type && event.data.sessionID === sessionID).length >= count,
    60_000,
  )
}

async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(100)
}

async function list() {
  return ((await call("GET", `/api/session/${sessionID}/message?limit=200`)) as { data: Message[] }).data
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: {
      authorization: engine.authorization,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(engine.project),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return response.status === 204 ? undefined : (response.json() as Promise<unknown>)
}
