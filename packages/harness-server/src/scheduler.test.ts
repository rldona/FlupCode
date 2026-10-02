import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { routineLockKey, SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * The scheduler's tick (TI-07): what fires when, and what a start that could not happen records.
 * The engine is a stand-in that answers at once: what is under test is which runs start and how
 * they are written down, not the turns inside them.
 */
const scratch: string[] = []
afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000

function setup(answer = "done") {
  const repository = new SqliteRoutineRepository(":memory:")
  const directory = mkdtempSync(join(tmpdir(), "flupcode-scheduler-"))
  scratch.push(directory)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  Object.assign(scheduler, {
    engine: {
      createSession: async () => ({ id: `ses_${crypto.randomUUID()}` }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: answer, cost: 0 }),
    },
  })
  // One tick, as the timer would run it. Not `start()`: that also clears every lock, as a restart
  // should, and one test needs a lock a run still holds.
  const tick = () => (scheduler as unknown as { tick: () => Promise<void> }).tick()
  return { repository, tick, directory, scheduler }
}

/** What an agent that gives up answers: the rule judges it `failed` (RP-06). */
const GIVES_UP = "I cannot do this, so I stop here."

const hourly = (directory: string, name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "",
  prompt: `Run ${name}`,
  schedule: { type: "hourly" as const },
  projectDirectory: directory,
  ...extra,
})

async function settled(repository: SqliteRoutineRepository, routineID: string, count: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const runs = repository.listRuns({ type: "routine", routineID })
    if (runs.length >= count && runs.every((run) => run.status !== "running")) return runs
    await Bun.sleep(10)
  }
  return repository.listRuns({ type: "routine", routineID })
}

describe("the scheduler's tick", () => {
  test("a routine whose workflow is gone leaves one failed run that says why", async () => {
    const { repository, tick, directory } = setup()
    const routine = repository.create(hourly(directory, "gone", { workflow: { name: "deleted-workflow" } }), {
      createdAt: Date.now() - 2 * HOUR,
    })
    await tick()
    const runs = await settled(repository, routine.id, 1)
    // Give a stale "running" object the time it would need to be executed and overwritten.
    await Bun.sleep(100)

    expect(repository.listRuns({ type: "routine", routineID: routine.id }).map((run) => run.status)).toEqual(["failed"])
    expect(runs[0]!.error).toContain("deleted-workflow")
    repository.close()
  })

  test("every due routine fires in one tick", async () => {
    const { repository, tick, directory } = setup()
    const long = Date.now() - 2 * HOUR
    const first = repository.create(hourly(directory, "first"), { createdAt: long })
    const second = repository.create(hourly(directory, "second"), { createdAt: long })
    await tick()
    const runs = [await settled(repository, first.id, 1), await settled(repository, second.id, 1)]

    expect(runs.map((list) => list.map((run) => run.status))).toEqual([["success"], ["success"]])
    repository.close()
  })

  test("a routine still running does not hold the others back", async () => {
    const { repository, tick, directory } = setup()
    const long = Date.now() - 2 * HOUR
    const busy = repository.create(hourly(directory, "busy"), { createdAt: long })
    const other = repository.create(hourly(directory, "other"), { createdAt: long })
    // `busy` is due again while its last run still holds the lock, which is what a long run does.
    expect(repository.acquire(routineLockKey(busy.id), "another-run", Date.now(), HOUR)).toBe(true)
    await tick()
    const runs = await settled(repository, other.id, 1)

    expect(runs.map((run) => run.status)).toEqual(["success"])
    expect(repository.listRuns({ type: "routine", routineID: busy.id })).toEqual([])
    repository.close()
  })

  test("after downtime a routine that missed several beats runs once, not once per beat", async () => {
    const { repository, tick, directory } = setup()
    const routine = repository.create(hourly(directory, "missed"), {
      createdAt: Date.now() - 10 * HOUR,
      lastRunAt: Date.now() - 6 * HOUR,
    })
    await tick()
    const runs = await settled(repository, routine.id, 1)
    await Bun.sleep(100)

    expect(runs.map((run) => run.status)).toEqual(["success"])
    expect(repository.listRuns({ type: "routine", routineID: routine.id })).toHaveLength(1)
    repository.close()
  })
})

describe("missed beats, retries and the failure notice (RP-07)", () => {
  test("skip lets a beat the server slept through go, and catch-up runs it", async () => {
    const { repository, tick, directory } = setup()
    // The last beat was half an hour ago and nobody ran it; the next is half an hour away.
    const lastRunAt = Date.now() - 6.5 * HOUR
    const skipped = repository.create(hourly(directory, "skip", { missed: "skip" }), { createdAt: lastRunAt, lastRunAt })
    const caught = repository.create(hourly(directory, "catch-up"), { createdAt: lastRunAt, lastRunAt })
    await tick()
    await settled(repository, caught.id, 1)
    await Bun.sleep(100)

    expect(repository.listRuns({ type: "routine", routineID: skipped.id })).toEqual([])
    expect(repository.listRuns({ type: "routine", routineID: caught.id })).toHaveLength(1)
    // What it waits for instead is the next beat on its own rhythm, not one counted from now.
    expect(repository.get(skipped.id)!.nextRunAt).toBe(lastRunAt + 7 * HOUR)
    repository.close()
  })

  test("a failed run is retried as many times as asked, each try a run of its own", async () => {
    const { repository, tick, directory } = setup(GIVES_UP)
    const routine = repository.create(hourly(directory, "flaky", { retry: { count: 2, backoffMinutes: 0 } }), {
      createdAt: Date.now() - 2 * HOUR,
    })
    for (const count of [1, 2, 3, 3]) {
      await tick()
      await settled(repository, routine.id, count)
    }
    const runs = repository.listRuns({ type: "routine", routineID: routine.id })

    expect(runs.map((run) => [run.attempt ?? 1, run.verdict?.value])).toEqual([
      [3, "failed"],
      [2, "failed"],
      [1, "failed"],
    ])
    // Retries are not beats: the schedule still counts from the first try.
    expect(repository.get(routine.id)!.lastRunAt).toBe(runs[2]!.startedAt)
    expect(repository.get(routine.id)!.nextRunAt).toBe(runs[2]!.startedAt + HOUR)
    repository.close()
  })

  test("three failed runs in a row raise one notice, however many more fail", async () => {
    const { repository, directory, scheduler } = setup(GIVES_UP)
    const routine = repository.create(hourly(directory, "broken"), { createdAt: Date.now() })
    const notices: unknown[] = []
    repository.subscribe((entry) => {
      if (entry.event.type === "routine.failing") notices.push(entry.event)
    })
    for (const count of [1, 2, 3, 4, 5]) {
      await scheduler.runNow(routine.id)
      await settled(repository, routine.id, count)
    }

    expect(notices).toEqual([
      { type: "routine.failing", routineID: routine.id, name: "broken", failedInARow: 3, sessionID: expect.any(String) },
    ])
    expect(repository.get(routine.id)).toMatchObject({ failedInARow: 5, failing: true })
    repository.close()
  })

  test("a run that succeeds starts the count again", async () => {
    const { repository, directory, scheduler } = setup(GIVES_UP)
    const routine = repository.create(hourly(directory, "recovers"), { createdAt: Date.now() })
    for (const count of [1, 2]) {
      await scheduler.runNow(routine.id)
      await settled(repository, routine.id, count)
    }
    expect(repository.get(routine.id)!.failedInARow).toBe(2)
    Object.assign(scheduler.engine, { lastAnswer: async () => ({ text: "done", cost: 0 }) })
    await scheduler.runNow(routine.id)
    await settled(repository, routine.id, 3)

    expect(repository.get(routine.id)).toMatchObject({ failedInARow: 0, failing: false })
    repository.close()
  })

  test("the inputs a routine was saved with reach its workflow's tasks", async () => {
    const { repository, tick, directory } = setup()
    mkdirSync(join(directory, ".flupcode", "workflows"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "workflows", "triage.yaml"),
      'name: triage\ninputs: [label]\ntasks:\n  - id: triage\n    prompt: "Triage the issues labelled {{label}}"\n',
    )
    const routine = repository.create(hourly(directory, "triage", { workflow: { name: "triage", inputs: { label: "bug" } } }), {
      createdAt: Date.now() - 2 * HOUR,
    })
    await tick()
    const [run] = await settled(repository, routine.id, 1)

    expect(repository.listTasks(run!.id).map((task) => task.prompt)).toEqual(["Triage the issues labelled bug"])
    expect(run!.workflow?.inputs).toEqual({ label: "bug" })
    repository.close()
  })
})
