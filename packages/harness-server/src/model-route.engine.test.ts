import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { Run } from "./types"

/**
 * Budget-aware model routing (PI-04) on the pinned OpenCode 2 engine, with two stub models behind two
 * providers: the run's own (`stub/stub-model`, priced) and its policy's fallback (`cheap/cheap-model`,
 * free). The ledger is fed by FlupCode's plugins, so the share the route reads is the one the budget
 * gate reads. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/model-route.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
// Every stub reply reports 10 input and 5 output tokens.
const PRICE = { input: 3, output: 15 }
const STEP_COST = (10 * PRICE.input + 5 * PRICE.output) / 1_000_000
const primary = startModel()
const cheap = startModel()
let engine: Engine
let repository: SqliteRoutineRepository
let scheduler: RoutineScheduler
let server: ReturnType<typeof Bun.serve>

const provider = (name: string, url: string, model: string, cost: { input: number; output: number }) => ({
  name,
  env: [],
  npm: "@ai-sdk/openai-compatible",
  options: { apiKey: "stub", baseURL: url },
  models: {
    [model]: {
      name,
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      release_date: "2025-01-01",
      limit: { context: 100_000, output: 10_000 },
      cost,
    },
  },
})

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  let handler: ReturnType<typeof createHarnessHandler> | undefined
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler!(request) })
  engine = await startEngine({
    modelUrl: primary.url,
    price: PRICE,
    config: {
      provider: {
        stub: provider("Stub", primary.url, "stub-model", PRICE),
        cheap: provider("Cheap", cheap.url, "cheap-model", { input: 0, output: 0 }),
      },
    },
    env: {
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${server.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    flupcodePlugins: true,
  })
  scheduler = new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization })
  handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
}, 180_000)

beforeEach(() => {
  primary.reset()
  cheap.reset()
  primary.requests.splice(0)
  cheap.requests.splice(0)
})

afterAll(async () => {
  await scheduler?.stopAll()
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  primary.stop()
  cheap.stop()
})

describe.skipIf(!run)("model routing on an OpenCode 2 engine", () => {
  test("a run at 80% of its budget starts its next task on the fallback model, and says why", async () => {
    // The first task and its closing note are two priced steps on the run's model: 2 of a 2.4-step
    // budget is 83%. The second task is the fallback's to answer.
    primary.push({ type: "text", text: "First done" }, { type: "text", text: "Note: first done" })
    cheap.push({ type: "text", text: "Second done on the fallback" })
    const started = await scheduler.runTasks({
      tasks: [
        { name: "first", prompt: "Do the first part", agent: "build" },
        { name: "second", prompt: "Do the second part", agent: "build" },
      ],
      directory: engine.project,
      policy: { models: { build: "stub/stub-model" }, fallback: "cheap/cheap-model", budget: { cost: 2.4 * STEP_COST } },
    })
    const finished = await settle(started.id)

    expect(finished.status).toBe("success")
    const [first, second] = repository.listTasks(started.id)
    expect(first!.route).toMatchObject({ model: "stub/stub-model", fallback: false })
    expect(second!.route).toMatchObject({ model: "cheap/cheap-model", fallback: true, source: "rule" })
    expect(second!.route!.reason).toBe("83% of the run's cost budget is spent, so this task runs on the policy's fallback model")
    expect(second!.output).toBe("Second done on the fallback")
    // The fallback's server got the second task's turn, and the run's model did not. FlupCode's memory
    // plugin quotes a finished session's transcript to the small model (the run's model here), but
    // that call offers no tools: an agent's turn is a request that does.
    expect(cheap.requests.filter(turn).map(asked)).toEqual([expect.stringContaining("Do the second part")])
    expect(primary.requests.filter(turn).map(asked).filter((text) => text.includes("Do the second part"))).toEqual([])
  }, 120_000)

  test("under 80% the next task stays on the run's model", async () => {
    primary.push({ type: "text", text: "First done" }, { type: "text", text: "Note" }, { type: "text", text: "Second done" })
    const started = await scheduler.runTasks({
      tasks: [
        { name: "first", prompt: "Do the first part", agent: "build" },
        { name: "second", prompt: "Do the second part", agent: "build" },
      ],
      directory: engine.project,
      policy: { models: { build: "stub/stub-model" }, fallback: "cheap/cheap-model", budget: { cost: 10 * STEP_COST } },
    })
    expect((await settle(started.id)).status).toBe("success")
    const second = repository.listTasks(started.id)[1]!
    expect(second.route).toMatchObject({ model: "stub/stub-model", fallback: false })
    expect(cheap.requests).toHaveLength(0)
  }, 120_000)
})

/** An agent's turn: a chat request that offers the agent its tools. */
const turn = (body: Record<string, unknown>) => Array.isArray(body.tools) && body.tools.length > 0

/** What a chat request asked: its last message, as text. */
function asked(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  return JSON.stringify(messages.at(-1)?.content ?? "")
}

/** The run once it is no longer running: at a gate, or finished. */
async function settle(runID: string): Promise<Run> {
  await until(() => repository.getRun(runID)?.status !== "running", 90_000)
  return repository.getRun(runID)!
}

async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(100)
}
