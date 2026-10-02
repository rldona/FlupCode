import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { dayStart, runStandings, standingBudgets } from "./budget"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { RunStatus, ServerEvent } from "./types"

/**
 * Budgets as policy (UL-08) with a fake ledger feed: the rows the session-metrics plugin would report
 * are written straight into the ledger and handed to `checkBudgets`, as the ingest route does. The
 * real engine and plugin are in `budget.engine.test.ts`.
 */

const open = () => new SqliteRoutineRepository(":memory:")

/** One step of a session, as the plugin reports it: `usd` absent is a step with no price. */
function spend(repository: SqliteRoutineRepository, sessionID: string, step: { usd?: number; tokens?: number }) {
  repository.recordUsage({
    events: [
      {
        id: `${sessionID}:step:${crypto.randomUUID()}`,
        kind: "step",
        sessionID,
        tokens: { input: step.tokens ?? 0, output: 0, reasoning: 0, cacheRead: 1_000, cacheWrite: 0 },
        ...(step.usd !== undefined ? { costUSD: step.usd } : {}),
        costBasis: step.usd !== undefined ? "engine-list-price" : "unpriced",
        billing: "metered",
        endedAt: Date.now(),
      },
    ],
    tools: [],
  })
}

/**
 * An engine whose first turn in each session runs until it is stopped, the way a turn the budget
 * interrupts does; the sessions it opened and interrupted are kept for the test to read.
 */
function busyEngine() {
  const sessions: string[] = []
  const interrupted: string[] = []
  const engine = {
    createSession: async () => {
      sessions.push(`ses_${sessions.length + 1}`)
      return { id: sessions.at(-1)! }
    },
    prompt: async () => undefined,
    waitForIdle: async (sessionID: string, options: { stopped: () => boolean }) => {
      if (sessionID !== "ses_1") return
      while (!options.stopped()) await Bun.sleep(5)
    },
    interrupt: async (sessionID: string) => void interrupted.push(sessionID),
    lastAnswer: async () => ({ text: "done" }),
  }
  return { engine, sessions, interrupted }
}

function schedulerWith(repository: SqliteRoutineRepository, engine: unknown) {
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  Object.assign(scheduler, { engine })
  return scheduler
}

const notices = (repository: SqliteRoutineRepository) =>
  repository
    .listEvents(0, 10_000)
    .flatMap((entry) => (entry.event.type === "budget.reached" ? [entry.event] : [])) as Array<
    Extract<ServerEvent, { type: "budget.reached" }>
  >

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

const statusOf = (repository: SqliteRoutineRepository, runID: string) => repository.getRun(runID)?.status as RunStatus

describe("a run's budget, step by step (UL-08)", () => {
  test("crossing it mid-turn stops the turn, fails the task with the budget, and pauses the run", async () => {
    const repository = open()
    const fake = busyEngine()
    const scheduler = schedulerWith(repository, fake.engine)
    const run = await scheduler.runTasks({
      tasks: [{ name: "busy", prompt: "Keep going" }],
      policy: { budget: { cost: 1, softPct: 50 } },
    })
    await until(() => repository.listTasks(run.id)[0]?.sessionID === "ses_1")

    spend(repository, "ses_1", { usd: 0.4 })
    scheduler.checkBudgets(["ses_1"])
    expect(notices(repository)).toEqual([])
    spend(repository, "ses_1", { usd: 0.2 })
    scheduler.checkBudgets(["ses_1"])
    spend(repository, "ses_1", { usd: 0.2 })
    scheduler.checkBudgets(["ses_1"])
    // The warning is said once, at the step that reached its share, and the turn goes on.
    expect(notices(repository).map((notice) => notice.level)).toEqual(["soft"])
    expect(statusOf(repository, run.id)).toBe("running")

    spend(repository, "ses_1", { usd: 0.3 })
    scheduler.checkBudgets(["ses_1"])
    await until(() => statusOf(repository, run.id) === "awaiting")

    const reason = "Reached the run's cost budget ($1)"
    expect(repository.getRun(run.id)).toMatchObject({ paused: "budget", overBudget: reason })
    expect(repository.listTasks(run.id)[0]).toMatchObject({
      status: "failed",
      error: reason,
      verdict: { value: "failed", reason },
    })
    expect(fake.interrupted).toContain("ses_1")
    // Rows that land after the stop say nothing new.
    spend(repository, "ses_1", { usd: 0.1 })
    scheduler.checkBudgets(["ses_1"])
    expect(notices(repository)).toEqual([
      expect.objectContaining({ level: "soft", scope: "run", runID: run.id, sessionID: "ses_1", limit: 1, unit: "usd" }),
      expect.objectContaining({ level: "hard", scope: "run", runID: run.id, sessionID: "ses_1", spent: 1.1 }),
    ])

    // Carrying on does the stopped task again, and the budget is not checked any more.
    scheduler.approve(run.id)
    await until(() => statusOf(repository, run.id) === "success")
    expect(repository.listTasks(run.id).map((task) => [task.status, task.attempt])).toEqual([
      ["failed", 1],
      ["success", 2],
    ])
    expect(repository.getRun(run.id)).toMatchObject({ budgetApproved: true })
    expect(repository.getRun(run.id)?.overBudget).toBeUndefined()
    repository.close()
  })

  test("the folder a stopped turn left, mid-edit, is kept as a checkpoint of its task", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-budget-cp-"))
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: directory })
    git(["init", "-q", "-b", "main"])
    git(["config", "user.email", "test@example.com"])
    git(["config", "user.name", "Test"])
    writeFileSync(join(directory, "kept.txt"), "one\n")
    git(["add", "-A"])
    git(["commit", "-qm", "first"])
    const fake = busyEngine()
    const scheduler = schedulerWith(repository, fake.engine)
    const run = await scheduler.runTasks({ tasks: [{ name: "busy", prompt: "go" }], directory, policy: { budget: { cost: 1 } } })
    await until(() => repository.listTasks(run.id)[0]?.sessionID === "ses_1")
    // Half an edit, when the step that crosses the budget lands.
    writeFileSync(join(directory, "half.txt"), "half of it")
    spend(repository, "ses_1", { usd: 1 })
    scheduler.checkBudgets(["ses_1"])
    await until(() => statusOf(repository, run.id) === "awaiting")

    const [task] = repository.listTasks(run.id)
    expect(repository.listCheckpoints({ runID: run.id })).toEqual([
      expect.objectContaining({ taskID: task!.id, title: "busy — stopped at its budget", summary: "Reached the run's cost budget ($1)" }),
    ])
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })

  test("a token budget counts input, output and reasoning, not the cache, and counts unpriced steps", async () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, Date.now(), undefined, {
      policy: { budget: { tokens: 100, cost: 1 } },
    })
    const [task] = repository.addTasks(run.id, [{ name: "one", prompt: "go" }])
    repository.attachTaskSession(task!.id, "ses_local")
    spend(repository, "ses_local", { tokens: 60 })
    spend(repository, "ses_local", { usd: 0.5, tokens: 30 })

    const standings = runStandings(repository, repository.getRun(run.id)!)
    // An unpriced step adds nothing to the cost figure, and says it was left out.
    expect(standings.find((entry) => entry.unit === "usd")).toMatchObject({ spent: 0.5, unpriced: 1 })
    expect(standings.find((entry) => entry.unit === "usd")?.level).toBeUndefined()
    // 2,000 cache tokens were read; the budget counts the 90 of work.
    expect(standings.find((entry) => entry.unit === "tokens")).toMatchObject({ spent: 90 })
    spend(repository, "ses_local", { tokens: 10 })
    expect(runStandings(repository, repository.getRun(run.id)!).find((entry) => entry.unit === "tokens")).toMatchObject({
      level: "hard",
      reason: "Reached the run's token budget (100)",
    })
    repository.close()
  })
})

describe("standing budgets (UL-08)", () => {
  test("a run started over a spent day budget pauses before its first task, and says so once", async () => {
    const repository = open()
    const fake = busyEngine()
    const scheduler = schedulerWith(repository, fake.engine)
    repository.saveBudget({ scope: "day", unit: "usd", limit: 1 })
    // A conversation spent it: nobody's run, but today's budget all the same.
    spend(repository, "ses_chat", { usd: 1.2 })

    const first = await scheduler.runTasks({ tasks: [{ name: "one", prompt: "go" }] })
    await until(() => statusOf(repository, first.id) === "awaiting")
    const second = await scheduler.runTasks({ tasks: [{ name: "two", prompt: "go" }] })
    await until(() => statusOf(repository, second.id) === "awaiting")

    expect(repository.getRun(first.id)).toMatchObject({ paused: "budget", overBudget: "Reached today's cost budget ($1)" })
    expect(repository.listTasks(first.id)[0]?.status).toBe("queued")
    expect(fake.sessions).toEqual([])
    expect(notices(repository).map((notice) => [notice.level, notice.scope, notice.name])).toEqual([["hard", "day", "today"]])
    repository.close()
  })

  test("a day crossed by a conversation stops the runs going, not the conversation", async () => {
    const repository = open()
    const fake = busyEngine()
    const scheduler = schedulerWith(repository, fake.engine)
    const run = await scheduler.runTasks({ tasks: [{ name: "busy", prompt: "go" }] })
    await until(() => repository.listTasks(run.id)[0]?.sessionID === "ses_1")
    repository.saveBudget({ scope: "day", unit: "usd", limit: 1, softPct: 80 })

    spend(repository, "ses_chat", { usd: 0.9 })
    scheduler.checkBudgets(["ses_chat"])
    expect(statusOf(repository, run.id)).toBe("running")
    spend(repository, "ses_chat", { usd: 0.2 })
    scheduler.checkBudgets(["ses_chat"])
    await until(() => statusOf(repository, run.id) === "awaiting")

    expect(fake.interrupted).toEqual(["ses_1"])
    expect(repository.listTasks(run.id)[0]).toMatchObject({ status: "failed", error: "Reached today's cost budget ($1)" })
    expect(notices(repository).map((notice) => [notice.level, notice.scope, notice.sessionID])).toEqual([
      ["soft", "day", "ses_chat"],
      ["hard", "day", "ses_chat"],
    ])
    repository.close()
  })

  test("a workflow's and a routine's budget cover their own runs, over today only", () => {
    const repository = open()
    const routine = repository.create({ name: "nightly", description: "", prompt: "go", schedule: { type: "manual" } })
    const review = { name: "review", scope: "project" as const, hash: "h1", inputs: {} }
    const reviewRun = repository.startRun({ type: "manual" }, Date.now(), undefined, { workflow: review })
    const routineRun = repository.startRun({ type: "routine", routineID: routine.id }, Date.now())
    const other = repository.startRun({ type: "manual" }, Date.now())
    repository.saveBudget({ scope: "workflow", target: "review", unit: "usd", limit: 1 })
    repository.saveBudget({ scope: "routine", target: routine.id, unit: "tokens", limit: 50 })
    for (const [run, sessionID] of [
      [reviewRun, "ses_review"],
      [routineRun, "ses_routine"],
    ] as const) {
      const [task] = repository.addTasks(run.id, [{ name: "one", prompt: "go" }])
      repository.attachTaskSession(task!.id, sessionID)
    }
    spend(repository, "ses_review", { usd: 1, tokens: 100 })
    spend(repository, "ses_routine", { usd: 0.1, tokens: 50 })
    // Yesterday's spend is yesterday's.
    repository.recordUsage({
      events: [
        {
          id: "ses_review:step:old",
          kind: "step",
          sessionID: "ses_review",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          costUSD: 5,
          costBasis: "engine-list-price",
          billing: "metered",
          endedAt: dayStart(Date.now()) - 1,
        },
      ],
      tools: [],
    })

    const scopes = (runID: string) =>
      runStandings(repository, repository.getRun(runID)!).map((entry) => [entry.scope, entry.name, entry.spent, entry.level])
    expect(scopes(reviewRun.id)).toEqual([["workflow", "review", 1, "hard"]])
    expect(scopes(routineRun.id)).toEqual([["routine", "nightly", 50, "hard"]])
    expect(scopes(other.id)).toEqual([])
    expect(standingBudgets(repository).map((entry) => entry.reason)).toEqual([
      "Reached the workflow review's daily cost budget ($1)",
      "Reached the routine nightly's daily token budget (50)",
    ])
    repository.close()
  })

  test("the API keeps one standing budget per scope, target and unit, and refuses what is not one", async () => {
    const repository = open()
    const routine = repository.create({ name: "nightly", description: "", prompt: "go", schedule: { type: "manual" } })
    const quick = {
      createSession: async () => ({ id: `ses_${crypto.randomUUID()}` }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    }
    const handler = createHarnessHandler(repository, schedulerWith(repository, quick), { token: "t" })
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await handler(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      )
      return { status: response.status, body: (await response.json()) as { data?: unknown; error?: string } }
    }

    expect((await call("PUT", "/harness/budgets", { scope: "day", unit: "usd", limit: 5, softPct: 80 })).status).toBe(200)
    expect((await call("PUT", "/harness/budgets", { scope: "routine", target: routine.id, unit: "usd", limit: 1 })).status).toBe(200)
    expect((await call("PUT", "/harness/budgets", { scope: "routine", target: "gone", unit: "usd", limit: 1 })).status).toBe(400)
    expect((await call("PUT", "/harness/budgets", { scope: "workflow", unit: "usd", limit: 1 })).status).toBe(400)
    expect((await call("PUT", "/harness/budgets", { scope: "day", unit: "usd", limit: -1 })).status).toBe(400)
    expect((await call("PUT", "/harness/budgets", { scope: "week", unit: "usd", limit: 1 })).status).toBe(400)
    // A warning share of 100 warns at the stop: it is not kept.
    expect((await call("PUT", "/harness/budgets", { scope: "day", unit: "tokens", limit: 9.5, softPct: 100 })).body.data).toMatchObject({
      limit: 9,
    })
    const listed = (await call("GET", "/harness/budgets")).body.data as Array<{ id: string; scope: string; softPct?: number; spent: number }>
    expect(listed.map((entry) => [entry.scope, entry.softPct, entry.spent])).toEqual([
      ["day", 80, 0],
      ["routine", undefined, 0],
      ["day", undefined, 0],
    ])
    expect((await call("DELETE", `/harness/budgets/${listed[0]!.id}`)).status).toBe(200)
    expect((await call("DELETE", `/harness/budgets/${listed[0]!.id}`)).status).toBe(404)
    expect((await call("GET", "/harness/budgets")).body.data).toHaveLength(2)

    // A run's policy takes a warning share with its limit, and none on its own.
    const run = await call("POST", "/harness/runs", {
      tasks: [{ name: "one", prompt: "go" }],
      policy: { budget: { cost: 2, softPct: 75 } },
    })
    expect((run.body.data as { policy?: unknown }).policy).toEqual({ budget: { cost: 2, softPct: 75 } })
    const bare = await call("POST", "/harness/runs", { tasks: [{ name: "one", prompt: "go" }], policy: { budget: { softPct: 75 } } })
    expect((bare.body.data as { policy?: unknown }).policy).toBeUndefined()
    for (const id of [(run.body.data as { id: string }).id, (bare.body.data as { id: string }).id])
      await until(() => statusOf(repository, id) === "success")
    // The run's ledger report carries its budget, where the card draws it from. Today's budgets cover
    // a run while it goes; once it has finished, only its own says anything about it.
    const report = await call("GET", `/harness/usage/runs/${(run.body.data as { id: string }).id}`)
    expect((report.body.data as { budgets: unknown[] }).budgets).toEqual([
      expect.objectContaining({ scope: "run", unit: "usd", limit: 2, softPct: 75, spent: 0 }),
    ])
    repository.close()
  })
})
