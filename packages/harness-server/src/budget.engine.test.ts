import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { Run } from "./types"

/**
 * Budgets as policy (UL-08) on the pinned OpenCode 2 engine: FlupCode's plugins feed the ledger step
 * by step from a priced stub model, and harness-server's own ingest route, scheduler and runner decide.
 * A run of one prompt whose agent keeps calling tools is stopped at the step that crosses its budget,
 * not after the turn, and warned once on the way. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/budget.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
// Every stub reply reports 10 input and 5 output tokens.
const PRICE = { input: 3, output: 15 }
const STEP_COST = (10 * PRICE.input + 5 * PRICE.output) / 1_000_000
const model = startModel()
let engine: Engine
let repository: SqliteRoutineRepository
let scheduler: RoutineScheduler
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  let handler: ReturnType<typeof createHarnessHandler> | undefined
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler!(request) })
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
  scheduler = new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization })
  handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
}, 180_000)

beforeEach(() => model.reset())

afterAll(async () => {
  await scheduler?.stopAll()
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  model.stop()
})

/** A turn that would go on calling tools: six steps of `echo`, then an answer. */
const busyTurn = () =>
  model.push(
    ...Array.from({ length: 6 }, (_, index) => ({
      type: "tool" as const,
      name: "shell",
      input: { command: `echo ${index}`, description: `Step ${index}` },
    })),
    { type: "text", text: "Done" },
  )

describe.skipIf(!run)("budgets on an OpenCode 2 engine", () => {
  test("a one-prompt run is stopped at the step that crosses its cost budget, and warned once before", async () => {
    busyTurn()
    const started = await scheduler.runTasks({
      tasks: [{ name: "busy", prompt: "Keep going" }],
      directory: engine.project,
      // Crossed by the third step; the warning by the second.
      policy: { budget: { cost: 2.5 * STEP_COST, softPct: 50 } },
    })
    const paused = await settle(started.id)

    expect(paused).toMatchObject({ status: "awaiting", paused: "budget" })
    const [task] = repository.listTasks(started.id)
    expect(task).toMatchObject({ status: "failed", verdict: { value: "failed" } })
    expect(task!.error).toContain("cost budget")
    // Within one step of crossing: the third step crossed it, and the fourth was cut short or never
    // asked for, so the stub still holds what the turn did not get to.
    const steps = repository.usageEvents(task!.sessionID!).filter((row) => row.kind === "step")
    expect(steps.length).toBeGreaterThanOrEqual(3)
    expect(steps.length).toBeLessThanOrEqual(4)
    expect(model.requests.length).toBeLessThanOrEqual(4)
    // One warning and one stop, however many rows arrived after each.
    const notices = repository.listEvents(0, 10_000).flatMap((entry) =>
      entry.event.type === "budget.reached" && entry.event.runID === started.id ? [entry.event.level] : [],
    )
    expect(notices).toEqual(["soft", "hard"])
  }, 120_000)

  test("carrying on past the budget does the stopped task again, and the run finishes", async () => {
    busyTurn()
    const started = await scheduler.runTasks({
      tasks: [{ name: "busy", prompt: "Keep going" }],
      directory: engine.project,
      policy: { budget: { cost: 1.5 * STEP_COST } },
    })
    expect(await settle(started.id)).toMatchObject({ status: "awaiting", paused: "budget" })
    model.reset()
    model.push({ type: "text", text: "Done after all" })
    expect(scheduler.approve(started.id)).toBeDefined()
    const finished = await settle(started.id)

    expect(finished).toMatchObject({ status: "success", budgetApproved: true })
    expect(repository.listTasks(started.id).map((task) => [task.status, task.attempt])).toEqual([
      ["failed", 1],
      ["success", 2],
    ])
  }, 120_000)

  test("a task's session has no title of the engine's, so the ledger the budget reads is its whole cost", async () => {
    model.push({ type: "text", text: "Done" })
    const started = await scheduler.runTasks({ tasks: [{ name: "one", prompt: "Answer" }], directory: engine.project })
    await settle(started.id)
    const [task] = repository.listTasks(started.id)
    await until(() => repository.usageEvents(task!.sessionID!).length > 0)
    const response = await fetch(`${engine.url}/api/session/${task!.sessionID}`, {
      headers: { authorization: engine.authorization, "x-opencode-directory": encodeURIComponent(engine.project) },
    })
    const session = ((await response.json()) as { data: { cost: number } }).data
    const ledger = repository.usageEvents(task!.sessionID!).reduce((sum, row) => sum + (row.costUSD ?? 0), 0)
    expect(ledger).toBeCloseTo(session.cost, 12)
  }, 60_000)
})

/** The run once it is no longer running: at a gate, or finished. */
async function settle(runID: string): Promise<Run> {
  await until(() => repository.getRun(runID)?.status !== "running", 90_000)
  return repository.getRun(runID)!
}

async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(100)
}
