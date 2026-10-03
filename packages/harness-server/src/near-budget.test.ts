import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { RunPolicy } from "./types"

/**
 * What a run does near its budget (CL-2) with a fake engine whose every turn writes one priced step to
 * the ledger, as the session-metrics plugin would. The real engine is in `near-budget.engine.test.ts`.
 */

/** An engine whose turns each cost `usd`, and that counts how many turns run at once. */
function pricedEngine(repository: SqliteRoutineRepository, usd: number) {
  const seen = { live: 0, most: 0, models: [] as Array<string | undefined> }
  let sessions = 0
  const engine = {
    createSession: async () => ({ id: `ses_${++sessions}` }),
    prompt: async (input: { sessionID: string; model?: { providerID: string; id: string } }) => {
      seen.models.push(input.model ? `${input.model.providerID}/${input.model.id}` : undefined)
      repository.recordUsage({
        events: [
          {
            id: `${input.sessionID}:step:1`,
            kind: "step",
            sessionID: input.sessionID,
            tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            costUSD: usd,
            costBasis: "engine-list-price",
            billing: "metered",
            endedAt: Date.now(),
          },
        ],
        tools: [],
      })
    },
    waitForIdle: async () => {
      seen.live++
      seen.most = Math.max(seen.most, seen.live)
      await Bun.sleep(20)
      seen.live--
    },
    interrupt: async () => undefined,
    lastAnswer: async () => ({ text: "done" }),
  }
  return { engine, seen }
}

/** One task, then three that wait only for it: without a limit the three run at once. */
const TASKS = [
  { name: "first", prompt: "go", agent: "build" },
  { name: "a", prompt: "go", agent: "build", dependsOn: ["first"] },
  { name: "b", prompt: "go", agent: "build", dependsOn: ["first"] },
  { name: "c", prompt: "go", agent: "build", dependsOn: ["first"] },
]

function setUp(policy: RunPolicy, usd = 0.1) {
  const repository = new SqliteRoutineRepository(":memory:")
  const fake = pricedEngine(repository, usd)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  Object.assign(scheduler, { engine: fake.engine })
  const handler = createHarnessHandler(repository, scheduler, { token: "ui-token" })
  const approve = (runID: string, body: unknown) =>
    handler(
      new Request(`http://localhost/harness/runs/${runID}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer ui-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  const start = () => scheduler.runTasks({ tasks: TASKS, policy })
  return { repository, seen: fake.seen, approve, start }
}

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

describe("a run near its budget (CL-2)", () => {
  test("under the line its parallel tasks run together", async () => {
    const subject = setUp({ budget: { cost: 10 } })
    const run = await subject.start()
    await until(() => subject.repository.getRun(run.id)?.status === "success")
    expect(subject.seen.most).toBe(3)
    expect(subject.repository.getRun(run.id)!.nearBudget).toBeUndefined()
  })

  test("past the line they run one at a time, and the run says why", async () => {
    // The first task's one step is 85% of the budget.
    const subject = setUp({ budget: { cost: 0.4 } }, 0.34)
    const run = await subject.start()
    await until(() => subject.repository.getRun(run.id)?.status !== "running")
    expect(subject.seen.most).toBe(1)
    expect(subject.repository.getRun(run.id)!.nearBudget).toMatchObject({ serial: true, share: 0.85 })
    expect(subject.repository.getRun(run.id)!.nearBudget!.reason).toBe(
      "85% of the run's cost budget is spent, so the remaining tasks start one at a time",
    )
  })

  test("the policy can keep them parallel", async () => {
    const subject = setUp({ budget: { cost: 10 }, fallback: "cheap/small", nearBudget: { serial: false } }, 8.5)
    const run = await subject.start()
    await until(() => subject.repository.getRun(run.id)?.status !== "running")
    expect(subject.seen.most).toBe(3)
  })

  test("at the gate a person carries on on the fallback; without one in the policy that answer is refused", async () => {
    const plain = setUp({ budget: { cost: 1 }, nearBudget: { gate: true } }, 0.85)
    const held = await plain.start()
    await until(() => plain.repository.getRun(held.id)?.status === "awaiting")
    expect(plain.repository.getRun(held.id)).toMatchObject({ paused: "threshold", nearBudget: { gate: { remaining: 3 } } })
    expect(plain.repository.getRun(held.id)!.nearBudget!.gate!.projected).toBeCloseTo(3 * 0.85, 10)
    expect((await plain.approve(held.id, { answer: "fallback" })).status).toBe(400)

    const subject = setUp({ budget: { cost: 10 }, fallback: "cheap/small", nearBudget: { gate: true } }, 8.5)
    const run = await subject.start()
    await until(() => subject.repository.getRun(run.id)?.status === "awaiting")
    expect(subject.repository.listTasks(run.id).filter((task) => task.status === "queued")).toHaveLength(3)
    expect((await subject.approve(run.id, { answer: "fallback" })).status).toBe(200)
    // The first of the three crosses the limit on the fake's flat price: the budget gate, as ever.
    await until(() => subject.repository.getRun(run.id)?.paused === "budget")
    expect(subject.repository.getRun(run.id)!.nearBudget!.gate!.answer).toBe("fallback")
    expect(subject.seen.models).toEqual([undefined, "cheap/small"])
  })
})
