import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { Run } from "./types"

/**
 * What a run does near its budget (CL-2) on the pinned OpenCode 2 engine, with two stub models behind
 * two providers: the run's own (`stub/stub-model`, priced) and its policy's fallback
 * (`cheap/cheap-model`, free). The ledger is fed by FlupCode's plugins, so the share the runner reads
 * is the one the budget gate reads. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/near-budget.engine.test.ts
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

// One task, then three that wait only for it: without a limit the three start at once.
const TASKS = [
  { name: "first", prompt: "Do the first part", agent: "build" },
  { name: "a", prompt: "Do part a", agent: "build", dependsOn: ["first"] },
  { name: "b", prompt: "Do part b", agent: "build", dependsOn: ["first"] },
  { name: "c", prompt: "Do part c", agent: "build", dependsOn: ["first"] },
]

// The first task and its closing note are two priced steps on the run's model: 2 of a 2.4-step budget
// is 83%, past the 80% line, before a, b and c start.
const policy = (extra: Record<string, unknown> = {}) => ({
  models: { build: "stub/stub-model" },
  fallback: "cheap/cheap-model",
  budget: { cost: 2.4 * STEP_COST },
  ...extra,
})

describe.skipIf(!run)("a run near its budget on an OpenCode 2 engine", () => {
  test("past 80% the remaining tasks start one at a time, and their closing notes move to the fallback", async () => {
    const started = await scheduler.runTasks({ tasks: TASKS, directory: engine.project, policy: policy() })
    const finished = await settle(started.id)

    expect(finished.status).toBe("success")
    expect(finished.nearBudget).toMatchObject({ scope: "run", unit: "usd", serial: true, fallback: "cheap/cheap-model" })
    expect(finished.nearBudget!.share).toBeCloseTo(2 / 2.4, 2)
    const rest = repository
      .listTasks(started.id)
      .filter((task) => task.name !== "first")
      .toSorted((x, y) => x.startedAt! - y.startedAt!)
    expect(rest.map((task) => task.status)).toEqual(["success", "success", "success"])
    // One at a time: each starts after the one before it has finished.
    expect(rest[1]!.startedAt!).toBeGreaterThanOrEqual(rest[0]!.finishedAt!)
    expect(rest[2]!.startedAt!).toBeGreaterThanOrEqual(rest[1]!.finishedAt!)
    expect(rest.every((task) => task.route?.fallback)).toBe(true)
    // The first task's note was written before the line, on the engine's default (the run's model);
    // the three after it on the fallback, so nothing past the line was spent on the priced model.
    expect(primary.requests.filter(note)).toHaveLength(1)
    expect(cheap.requests.filter(note)).toHaveLength(3)
    expect(repository.getRun(started.id)!.overBudget).toBeUndefined()
  }, 180_000)

  test("with the gate in the policy, the run waits at 80% with what the rest would cost; on the fallback it finishes", async () => {
    const started = await scheduler.runTasks({ tasks: TASKS, directory: engine.project, policy: policy({ nearBudget: { gate: true } }) })
    const waiting = await settle(started.id)

    expect(waiting.status).toBe("awaiting")
    expect(waiting.paused).toBe("threshold")
    expect(repository.listTasks(started.id).filter((task) => task.status === "queued")).toHaveLength(3)
    // What the first task cost with its note (two steps), for each of the three left.
    expect(waiting.nearBudget!.gate).toMatchObject({ remaining: 3 })
    expect(waiting.nearBudget!.gate!.projected).toBeCloseTo(3 * 2 * STEP_COST, 8)
    expect(waiting.nearBudget!.gate!.answer).toBeUndefined()

    const answered = await approve(started.id, { answer: "fallback" })
    expect(answered.status).toBe(200)
    const finished = await settle(started.id)
    expect(finished.status).toBe("success")
    expect(finished.nearBudget!.gate!.answer).toBe("fallback")
    expect(repository.listTasks(started.id).filter((task) => task.name !== "first").every((task) => task.route?.fallback)).toBe(true)
  }, 180_000)

  test("carrying on at the gate keeps the run's models, and the budget still stops it at its limit", async () => {
    const started = await scheduler.runTasks({ tasks: TASKS, directory: engine.project, policy: policy({ nearBudget: { gate: true } }) })
    expect((await settle(started.id)).paused).toBe("threshold")

    expect((await approve(started.id, { answer: "continue" })).status).toBe(200)
    const stopped = await settle(started.id)
    // The next task ran on the run's model, which crossed the limit: the budget gate, as before.
    expect(stopped.status).toBe("awaiting")
    expect(stopped.paused).toBe("budget")
    const next = repository.listTasks(started.id).find((task) => task.name !== "first" && task.status !== "queued")!
    expect(next.route).toMatchObject({ model: "stub/stub-model", fallback: false })
    expect(next.route!.reason).toContain("chose to keep")
    expect(cheap.requests.filter(turn)).toHaveLength(0)
  }, 180_000)
})

/**
 * A closing note's turn (H-31). FlupCode's memory plugin later quotes the note's transcript to the small
 * model, but that call offers no tools.
 */
const note = (body: Record<string, unknown>) => turn(body) && asked(body).includes("Summarise this step for the next one")

async function approve(runID: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${server.port}/harness/runs/${runID}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer ui-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** An agent's turn: a chat request that offers the agent its tools. */
const turn = (body: Record<string, unknown>) => Array.isArray(body.tools) && body.tools.length > 0

/** What a chat request asked: its last message, as text. */
function asked(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  return JSON.stringify(messages.at(-1)?.content ?? "")
}

/** The run once it is no longer running: at a gate, or finished. */
async function settle(runID: string): Promise<Run> {
  await until(() => repository.getRun(runID)?.status !== "running", 120_000)
  return repository.getRun(runID)!
}

async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(100)
}
