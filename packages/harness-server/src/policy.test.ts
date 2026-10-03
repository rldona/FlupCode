import { describe, expect, test } from "bun:test"
import type { DecisionResult } from "./adaptive/decision"
import { fallbackModel, modelForTask, nearBudget, nearBudgetActions, noteModel, parseModelKey, routeTask, runPressure, type Pressure } from "./policy"
import type { QuotaWindow } from "./quota/adapters"
import { SqliteRoutineRepository } from "./repository"
import type { RunPolicy } from "./types"

describe("reading a model key", () => {
  test("provider/model is the two ids the engine wants", () => {
    expect(parseModelKey("anthropic/claude")).toEqual({ providerID: "anthropic", id: "claude" })
  })

  test("only the first slash splits it, so a nested id survives", () => {
    expect(parseModelKey("openrouter/meta/llama")).toEqual({ providerID: "openrouter", id: "meta/llama" })
  })

  test("anything that is not a model is not one", () => {
    for (const value of [undefined, "", "   ", "claude", "/claude", "anthropic/"]) {
      expect(parseModelKey(value)).toBeUndefined()
    }
  })
})

describe("the model a task runs on", () => {
  test("its own wins over the policy", () => {
    const task = { model: { providerID: "a", id: "own" }, agent: "build" }
    expect(modelForTask(task, { models: { build: "a/policy" } })).toEqual({ providerID: "a", id: "own" })
  })

  test("the policy fills the gap for the role it runs as", () => {
    expect(modelForTask({ agent: "plan" }, { models: { plan: "anthropic/claude" } })).toEqual({
      providerID: "anthropic",
      id: "claude",
    })
  })

  test("no policy, or a role it does not name, leaves the engine's default alone", () => {
    expect(modelForTask({ agent: "plan" }, undefined)).toBeUndefined()
    expect(modelForTask({ agent: "plan" }, { models: { build: "a/b" } })).toBeUndefined()
    expect(modelForTask({}, { models: { plan: "a/b" } })).toBeUndefined()
  })
})

describe("the model a retry falls back to", () => {
  test("the policy's fallback, when it names one", () => {
    expect(fallbackModel({ fallback: "a/backup" }, { providerID: "a", id: "primary" })).toEqual({
      providerID: "a",
      id: "backup",
    })
  })

  test("the same model is not asked again", () => {
    const current = { providerID: "a", id: "same" }
    expect(fallbackModel({ fallback: "a/same" }, current)).toEqual(current)
  })

  test("no fallback keeps what there was", () => {
    const current = { providerID: "a", id: "one" }
    expect(fallbackModel(undefined, current)).toEqual(current)
    expect(fallbackModel({}, current)).toEqual(current)
  })
})

// ---- routing under pressure (PI-04) ------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const HOUR = 60 * 60_000

/** A run with one task whose session has spent `usd`, as the ledger records a priced step. */
function runThatSpent(repository: SqliteRoutineRepository, usd: number, policy: RunPolicy) {
  const run = repository.startRun({ type: "manual" }, NOW, undefined, { policy })
  const [task] = repository.addTasks(run.id, [{ name: "one", prompt: "go", agent: "build" }])
  repository.attachTaskSession(task!.id, `ses_${run.id}`)
  repository.recordUsage({
    events: [
      {
        id: `ses_${run.id}:step:1`,
        kind: "step",
        sessionID: `ses_${run.id}`,
        tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        costUSD: usd,
        costBasis: "engine-list-price",
        billing: "metered",
        endedAt: NOW - 1_000,
      },
    ],
    tools: [],
  })
  return repository.getRun(run.id)!
}

const window = (overrides: Partial<QuotaWindow>): QuotaWindow => ({
  id: "key-limit",
  kind: "calendar",
  unit: "credits",
  used: 5,
  limit: 10,
  remaining: 5,
  resetAt: NOW + 6 * HOUR,
  ...overrides,
})

const POLICY: RunPolicy = { models: { build: "big/large" }, fallback: "cheap/small", budget: { cost: 1 } }

describe("how close a run is to its limits", () => {
  test("the budget furthest spent, on the ledger: the run's own or a standing one that covers it", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = runThatSpent(repository, 0.5, POLICY)
    expect(runPressure(repository, run, undefined, NOW).budget).toMatchObject({ share: 0.5, standing: { scope: "run", unit: "usd" } })
    // Today's budget is spent further by the same step, so it is the one that counts.
    repository.saveBudget({ scope: "day", unit: "usd", limit: 0.6 })
    expect(runPressure(repository, run, undefined, NOW).budget).toMatchObject({ standing: { scope: "day" } })
    expect(runPressure(repository, run, undefined, NOW).budget!.share).toBeCloseTo(0.5 / 0.6, 10)
    repository.close()
  })

  test("no budget is no budget reading", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = runThatSpent(repository, 0.5, { fallback: "cheap/small" })
    expect(runPressure(repository, run, undefined, NOW)).toEqual({})
    repository.close()
  })

  test("the provider's shortest window from its latest reading: the one that resets first", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = runThatSpent(repository, 0, POLICY)
    const day = window({ id: "free-requests", unit: "requests", used: 45, limit: 50, remaining: 5, resetAt: NOW + 2 * HOUR })
    repository.addQuotaSamples({ providerID: "big", account: "cred_1", at: NOW - 10 * 60_000, source: "docs", windows: [window({}), day] })
    expect(runPressure(repository, run, "big", NOW).quota).toMatchObject({ providerID: "big", window: { id: "free-requests" }, share: 0.9 })
    // Another provider's reading says nothing about this one.
    expect(runPressure(repository, run, "other", NOW).quota).toBeUndefined()
    repository.close()
  })

  test("a stale reading, a window that has reset since and a balance with no limit say nothing", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = runThatSpent(repository, 0, POLICY)
    repository.addQuotaSamples({ providerID: "old", account: "a", at: NOW - 2 * HOUR, source: "docs", windows: [window({ used: 9.5 })] })
    expect(runPressure(repository, run, "old", NOW).quota).toBeUndefined()
    repository.addQuotaSamples({ providerID: "reset", account: "a", at: NOW - 60_000, source: "docs", windows: [window({ used: 9.5, resetAt: NOW - 1 })] })
    expect(runPressure(repository, run, "reset", NOW).quota).toBeUndefined()
    repository.addQuotaSamples({
      providerID: "deepseek",
      account: "a",
      at: NOW - 60_000,
      source: "docs",
      windows: [window({ id: "balance-usd", kind: "balance", unit: "usd", used: null, limit: null, remaining: 3, resetAt: null })],
    })
    expect(runPressure(repository, run, "deepseek", NOW).quota).toBeUndefined()
    // A cap with only what remains still has a share: what is gone of it.
    repository.addQuotaSamples({ providerID: "cap", account: "a", at: NOW - 60_000, source: "docs", windows: [window({ kind: "spendCap", used: null, remaining: 1, resetAt: null })] })
    expect(runPressure(repository, run, "cap", NOW).quota?.share).toBe(0.9)
    repository.close()
  })
})

const standing = (share: number) => ({
  share,
  standing: { key: "run:r:usd", scope: "run" as const, name: "Run", unit: "usd" as const, limit: 1, spent: share, unpriced: 0, reason: "" },
})
const quota = (share: number) => ({ providerID: "big", window: window({ used: share * 10 }), share, at: NOW })
const build = { agent: "build" }

describe("the model a task is routed to", () => {
  test("under 80% of its budget, a task runs on its role's model and says how far the run is", async () => {
    const routed = await routeTask({ task: build, policy: POLICY, pressure: { budget: standing(0.5) } })
    expect(routed).toEqual({
      model: { providerID: "big", id: "large" },
      route: {
        model: "big/large",
        fallback: false,
        reason:
          "The policy's model for the build role; 50% of the run's cost budget is spent, under the 80% at which the run moves to its fallback",
        source: "rule",
      },
    })
  })

  test("at 80% of its budget, the next task runs on the policy's fallback, and says why", async () => {
    const routed = await routeTask({ task: build, policy: POLICY, pressure: { budget: standing(0.8) } })
    expect(routed).toEqual({
      model: { providerID: "cheap", id: "small" },
      route: {
        model: "cheap/small",
        fallback: true,
        reason: "80% of the run's cost budget is spent, so this task runs on the policy's fallback model",
        source: "rule",
      },
    })
  })

  test("a quota window of the model's provider over 80% moves it too, and the reason says the reading is the whole key's", async () => {
    const routed = await routeTask({ task: build, policy: POLICY, pressure: { budget: standing(0.1), quota: quota(0.85) } })
    expect(routed.model).toEqual({ providerID: "cheap", id: "small" })
    expect(routed.route.reason).toBe(
      "85% of big's shortest quota window (key-limit, resets 2026-10-03 18:00 UTC) is used, a reading of the whole key that counts its use outside FlupCode too, so this task runs on the policy's fallback model",
    )
  })

  test("a task that names its own model is routed as well: the budget is the run's", async () => {
    const routed = await routeTask({ task: { model: { providerID: "big", id: "pinned" } }, policy: POLICY, pressure: { budget: standing(0.9) } })
    expect(routed.route).toMatchObject({ model: "cheap/small", fallback: true })
    const calm = await routeTask({ task: { model: { providerID: "big", id: "pinned" } }, policy: POLICY, pressure: {} })
    expect(calm.route).toEqual({ model: "big/pinned", fallback: false, reason: "The task's own model", source: "rule" })
  })

  test("with no fallback, or the fallback already running, the task stays and the reason says so", async () => {
    const none = await routeTask({ task: build, policy: { models: POLICY.models }, pressure: { budget: standing(0.9) } })
    expect(none.route).toEqual({
      model: "big/large",
      fallback: false,
      reason: "The policy's model for the build role. 90% of the run's cost budget is spent, and the policy names no other model to move to",
      source: "rule",
    })
    const same = await routeTask({ task: build, policy: { ...POLICY, fallback: "big/large" }, pressure: { budget: standing(0.9) } })
    expect(same.route).toMatchObject({ model: "big/large", fallback: false })
    const engine = await routeTask({ task: {}, policy: undefined, pressure: {} })
    expect(engine).toEqual({ route: { fallback: false, reason: "The engine's default model", source: "rule" } })
  })

  test("a routing model may move a task sooner, never keep it past the line, and its failure leaves the rule", async () => {
    const said = (route: "keep" | "fallback") => async () =>
      ({ kind: "modelRoute", answer: { route }, source: "model", provider: "jev" }) as DecisionResult<"modelRoute">
    const sooner = await routeTask({ task: build, policy: POLICY, pressure: { budget: standing(0.6) }, router: said("fallback") })
    expect(sooner.route).toEqual({
      model: "cheap/small",
      fallback: true,
      reason: "The routing model (jev) moved this task to the fallback model before the 80% line; 60% of the run's cost budget is spent",
      source: "model",
    })
    const past = await routeTask({ task: build, policy: POLICY, pressure: { budget: standing(0.9) }, router: said("keep") })
    expect(past.route).toMatchObject({ model: "cheap/small", fallback: true, source: "rule" })
    const failed = await routeTask({
      task: build,
      policy: POLICY,
      pressure: { budget: standing(0.6) },
      router: () => Promise.reject(new Error("down")),
    })
    expect(failed.route).toMatchObject({ model: "big/large", fallback: false, source: "rule" })
  })

  test("nothing to read is nothing to ask: no budget and no quota never asks the routing model", async () => {
    const asked: Pressure[] = []
    await routeTask({
      task: build,
      policy: POLICY,
      pressure: {},
      router: async () => {
        asked.push({})
        throw new Error("not asked")
      },
    })
    expect(asked).toEqual([])
  })
})

// ---- what else a run does near its budget (CL-2) ------------------------------------------------

/** A run whose first task finished having spent `usd`, with `left` agent tasks still queued. */
function runNearBudget(repository: SqliteRoutineRepository, usd: number, policy: RunPolicy, left = 3) {
  const run = runThatSpent(repository, usd, policy)
  const [first] = repository.listTasks(run.id)
  repository.finishTask(first!.id, "success", {}, NOW - 500)
  repository.addTasks(
    run.id,
    Array.from({ length: left }, (_, index) => ({ name: `next-${index}`, prompt: "go", agent: "build", dependsOn: ["one"] })),
  )
  return { run, tasks: repository.listTasks(run.id) }
}

describe("what a run does near its budget", () => {
  test("by default one task at a time and no gate; the policy turns either", () => {
    expect(nearBudgetActions(undefined)).toEqual({ serial: true, gate: false })
    expect(nearBudgetActions({ nearBudget: { serial: false, gate: true } })).toEqual({ serial: false, gate: true })
  })

  test("at 80% of its budget it starts the rest one at a time and moves them to the fallback, and says so", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const { run, tasks } = runNearBudget(repository, 0.85, POLICY)
    const near = nearBudget(repository, run, tasks, runPressure(repository, run, undefined, NOW), NOW)
    expect(near).toEqual({
      scope: "run",
      name: "Run",
      unit: "usd",
      spent: 0.85,
      limit: 1,
      share: 0.85,
      at: NOW,
      serial: true,
      fallback: "cheap/small",
      reason:
        "85% of the run's cost budget is spent, so the remaining tasks start one at a time, they run on the policy's fallback model",
    })
    repository.close()
  })

  test("with the gate, it says how many agent tasks are left and what they would add at the run's pace so far", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const { run, tasks } = runNearBudget(repository, 0.8, { ...POLICY, nearBudget: { gate: true } })
    const near = nearBudget(repository, run, tasks, runPressure(repository, run, undefined, NOW), NOW)!
    expect(near.gate).toMatchObject({ remaining: 3 })
    expect(near.gate!.projected).toBeCloseTo(2.4, 10)
    expect(near.reason).toEndWith("the run waits for a person before going on")
    repository.close()
  })

  test("no task finished yet is no pace to project from, and no task left is nothing to ask about", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const policy = { ...POLICY, nearBudget: { gate: true } }
    // Spent before any of its tasks finished: the gate opens with no figure.
    const fresh = runThatSpent(repository, 0.9, policy)
    const near = nearBudget(repository, fresh, repository.listTasks(fresh.id), runPressure(repository, fresh, undefined, NOW), NOW)!
    expect(near.gate).toEqual({ remaining: 1 })
    const { run, tasks } = runNearBudget(repository, 0.9, policy, 0)
    expect(nearBudget(repository, run, tasks, runPressure(repository, run, undefined, NOW), NOW)!.gate).toBeUndefined()
    repository.close()
  })

  test("nothing below the line, at the limit, past an approved budget, or with nothing to do", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const check = (usd: number, policy: RunPolicy, approved = false) => {
      const { run, tasks } = runNearBudget(repository, usd, policy)
      if (approved) repository.approveBudget(run.id)
      const read = repository.getRun(run.id)!
      return nearBudget(repository, read, tasks, runPressure(repository, read, undefined, NOW), NOW)
    }
    expect(check(0.79, POLICY)).toBeUndefined()
    // The limit is the budget gate's (UL-08).
    expect(check(1, POLICY)).toBeUndefined()
    expect(check(0.9, POLICY, true)).toBeUndefined()
    expect(check(0.9, { budget: { cost: 1 }, nearBudget: { serial: false } })).toBeUndefined()
    expect(check(0.9, { budget: { cost: 1 } })).toMatchObject({ serial: true })
    repository.close()
  })

  test("a closing note moves to the fallback with its task, or once the run is past the line, unless a person kept the models", () => {
    const moved = { model: "cheap/small", fallback: true, reason: "", source: "rule" as const }
    const kept = { model: "big/large", fallback: false, reason: "", source: "rule" as const }
    const small = { providerID: "cheap", id: "small" }
    expect(noteModel({ policy: POLICY, route: moved, pressure: {} })).toEqual(small)
    expect(noteModel({ policy: POLICY, route: kept, pressure: { budget: standing(0.8) } })).toEqual(small)
    expect(noteModel({ policy: POLICY, route: kept, pressure: { budget: standing(0.5) } })).toBeUndefined()
    expect(noteModel({ policy: POLICY, route: moved, pressure: { budget: standing(0.9) }, kept: true })).toBeUndefined()
    expect(noteModel({ policy: { budget: { cost: 1 } }, route: kept, pressure: { budget: standing(0.9) } })).toBeUndefined()
  })
})
