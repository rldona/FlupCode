import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { RoutineScheduler } from "./scheduler"
import type { RunSource, RunStatus } from "./types"

/** Waits for a run the scheduler is driving to reach a state, rather than guessing at a delay. */
const settledAt = async (
  repository: SqliteRoutineRepository,
  runID: string,
  status: RunStatus,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs
  while (repository.getRun(runID)?.status !== status && Date.now() < deadline) await Bun.sleep(10)
  expect(repository.getRun(runID)?.status).toBe(status)
}

const scratch: string[] = []
afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const open = () => new SqliteRoutineRepository(":memory:")
const manual: RunSource = { type: "manual" }

const work = [
  { name: "plan", prompt: "Write the plan" },
  { name: "build", prompt: "Do it", agent: "build" },
]

describe("a run made of tasks", () => {
  test("tasks keep the order they were given", () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    const created = repository.addTasks(run.id, work)

    expect(created.map((task) => task.position)).toEqual([0, 1])
    expect(repository.listTasks(run.id).map((task) => task.name)).toEqual(["plan", "build"])
    expect(repository.listTasks(run.id).every((task) => task.status === "queued")).toBe(true)
    repository.close()
  })

  test("tasks added later go after the ones already there", () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, work)
    const more = repository.addTasks(run.id, [{ name: "verify", prompt: "Check it" }])

    expect(more[0]!.position).toBe(2)
    expect(repository.listTasks(run.id).map((task) => task.name)).toEqual(["plan", "build", "verify"])
    repository.close()
  })

  // A task runs as a session of its own, and what it answered is kept so the next one can be handed
  // it without replaying a transcript.
  test("a task carries its session, its result and what it cost", () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    const [task] = repository.addTasks(run.id, work)

    repository.startTask(task!.id, 1100)
    repository.attachTaskSession(task!.id, "ses_child")
    repository.finishTask(task!.id, "success", { output: "the plan", tokens: 1200, cost: 0.03 }, 1500)

    expect(repository.getTask(task!.id)).toMatchObject({
      status: "success",
      sessionID: "ses_child",
      startedAt: 1100,
      finishedAt: 1500,
      output: "the plan",
      tokens: 1200,
      cost: 0.03,
    })
    repository.close()
  })

  test("every step of a task is on the stream", () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    const [task] = repository.addTasks(run.id, [work[0]!])
    repository.startTask(task!.id, 1100)
    repository.finishTask(task!.id, "failed", { error: "no" }, 1200)

    const tasks = repository.listEvents(0).filter((entry) => entry.event.type === "task.changed")
    expect(tasks.map((entry) => (entry.event as { task: { status: string } }).task.status)).toEqual([
      "queued",
      "running",
      "failed",
    ])
    repository.close()
  })

  test("deleting a routine takes the tasks of its runs with it", () => {
    const repository = open()
    const routine = repository.create({
      name: "Nightly",
      description: "",
      prompt: "x",
      schedule: { type: "manual" },
    })
    const run = repository.startRun({ type: "routine", routineID: routine.id }, 1000)
    const [task] = repository.addTasks(run.id, [work[0]!])

    repository.remove(routine.id)
    expect(repository.getTask(task!.id)).toBeUndefined()
    repository.close()
  })
})

// H-22: a verify task is run by the harness, not by a model. These drive the runner with an engine
// that would throw if it were touched, which is the point — verification must not cost a turn.
describe("a verify task", () => {
  const engine = new Proxy({} as never, {
    get(_target, name) {
      throw new Error(`the runner asked the engine for ${String(name)} during a verify task`)
    },
  })

  test("runs the project's commands, passes, and keeps the evidence", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-run-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), "verify:\n  test: echo 3 tests passed\n")

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    const [task] = repository.listTasks(run.id)
    expect(task!.status).toBe("success")
    expect(task!.sessionID).toBeUndefined()
    expect(task!.output).toContain("Verification: passed")
    expect(task!.output).toContain("- test (echo 3 tests passed) — ok")
    repository.close()
  })

  test("a failure stops the run and says which step failed", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-run-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      "verify:\n  typecheck: true\n  test: echo 'expected 1, got 2' >&2; exit 1\n",
    )

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "verify", prompt: "", kind: "verify" },
      { name: "after", prompt: "Should not run" },
    ])
    const runner = new TaskRunner(repository, engine)
    await expect(runner.execute(run, { directory })).rejects.toThrow("Verification failed: test")

    const [verify, after] = repository.listTasks(run.id)
    expect(verify!.status).toBe("failed")
    expect(verify!.error).toBe("Verification failed: test")
    // The evidence quotes what broke, so the retry that follows has something to work from.
    expect(verify!.output).toContain("expected 1, got 2")
    // And the run does not carry on as if it had passed.
    expect(after!.status).toBe("queued")
    repository.close()
  })

  test("a project nobody can check does not report that it checked out", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-run-"))
    scratch.push(directory)

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify" }])
    await expect(new TaskRunner(repository, engine).execute(run, { directory })).rejects.toThrow(
      "Nothing to verify",
    )
    expect(repository.listTasks(run.id)[0]!.status).toBe("failed")
    repository.close()
  })
})

// H-22's second half: a failed check puts the work back, with the evidence, a bounded number of
// times. A retry is a new task — the first attempt's session, output and cost stay readable.
describe("a bounded retry", () => {
  /** An engine that answers, and remembers what each attempt was told. */
  const recordingEngine = (prompts: string[]) =>
    ({
      createSession: async () => ({ id: `ses_${prompts.length}` }),
      prompt: async (input: { text: string }) => void prompts.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done", tokens: 10, cost: 0.01 }),
    }) as never

  const failingThenPassing = (directory: string) => {
    // The check reads a file the "agent" cannot change, so the fixture decides when it starts passing.
    writeFileSync(join(directory, "broken"), "yes")
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      "verify:\n  test: test ! -f broken || { echo 'still broken' >&2; exit 1; }\n",
    )
  }

  test("the work is attempted again with the evidence, and the run recovers", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-retry-"))
    scratch.push(directory)
    failingThenPassing(directory)

    const prompts: string[] = []
    const engine = {
      createSession: async () => ({ id: `ses_${prompts.length}` }),
      prompt: async (input: { text: string }) => {
        prompts.push(input.text)
        // The second attempt "fixes" it, which is what the retry exists to allow.
        if (prompts.length > 1) rmSync(join(directory, "broken"))
      },
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "verify", prompt: "", kind: "verify", retries: 2 },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    const tasks = repository.listTasks(run.id)
    expect(tasks.map((task) => `${task.name}#${task.attempt}:${task.status}`)).toEqual([
      "build#1:success",
      "verify#1:failed",
      "build#2:success",
      "verify#2:success",
    ])
    // A retry is a new task: the first attempt is still there to read.
    expect(tasks[2]!.retryOf).toBe(tasks[0]!.id)
    // And the second attempt was told what the check said, not just asked again.
    expect(prompts[1]).toContain("Make it work")
    expect(prompts[1]).toContain("The previous attempt did not pass verification")
    expect(prompts[1]).toContain("still broken")
    repository.close()
  })

  test("the budget is spent, and then the run fails", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-retry-"))
    scratch.push(directory)
    failingThenPassing(directory)

    const prompts: string[] = []
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "verify", prompt: "", kind: "verify", retries: 1 },
    ])
    const runner = new TaskRunner(repository, recordingEngine(prompts))
    await expect(runner.execute(run, { directory })).rejects.toThrow("Verification failed: test")

    // One retry, not more: the budget travels with the check and is spent as it is used.
    expect(repository.listTasks(run.id).map((task) => `${task.name}#${task.attempt}`)).toEqual([
      "build#1",
      "verify#1",
      "build#2",
      "verify#2",
    ])
    expect(prompts).toHaveLength(2)
    repository.close()
  })

  test("without a budget, a failed check is still the end of the run", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-retry-"))
    scratch.push(directory)
    failingThenPassing(directory)

    const prompts: string[] = []
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "verify", prompt: "", kind: "verify" },
    ])
    await expect(
      new TaskRunner(repository, recordingEngine(prompts)).execute(run, { directory }),
    ).rejects.toThrow("Verification failed")
    expect(repository.listTasks(run.id)).toHaveLength(2)
    repository.close()
  })

  test("a check with nothing before it has nothing to attempt again", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-retry-"))
    scratch.push(directory)
    failingThenPassing(directory)

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify", retries: 3 }])
    await expect(
      new TaskRunner(repository, recordingEngine([])).execute(run, { directory }),
    ).rejects.toThrow("Verification failed")
    expect(repository.listTasks(run.id)).toHaveLength(1)
    repository.close()
  })
})

// H-14: the two things the harness already knew and used to throw away — what a check found, and
// what a run added up to.
describe("what a run keeps", () => {
  test("a check writes its verdict down, and it outlives the task list", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-artifact-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), "verify:\n  test: echo fine\n")

    const run = repository.startRun(manual, 1000)
    const [task] = repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify" }])
    await new TaskRunner(repository, {} as never).execute(run, { directory })

    const [artifact] = repository.listArtifacts({ runID: run.id })
    expect(artifact?.kind).toBe("verdict")
    expect(artifact?.title).toBe("verify — passed")
    expect(artifact?.producer).toBe("harness")
    expect(artifact?.taskID).toBe(task!.id)
    expect(artifact?.content).toContain("Verification: passed")
    repository.close()
  })

  test("a run that ends writes down what it did", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, {
      engine: {
        createSession: async () => ({ id: "ses_a" }),
        prompt: async () => undefined,
        waitForIdle: async () => undefined,
        lastAnswer: async () => ({ text: "done", tokens: 120, cost: 0.02 }),
      },
    })

    const run = await scheduler.runTasks({ tasks: [{ name: "build", prompt: "Do it" }] })
    await settledAt(repository, run.id, "success")

    const [report] = repository.listArtifacts({ runID: run.id, kind: "report" })
    expect(report?.title).toBe("Run success")
    expect(report?.content).toContain("- build — success")
    // The totals §6.3 wanted in the run's session, which the engine cannot be asked for free.
    expect(report?.content).toContain("1 tasks, 120 tokens, $0.0200")
    repository.close()
  })
})

// H-21's human gate: the run stops after a task somebody has to read, and nothing else starts until
// they answer. Refusing is stopping it — there is no third answer to "carry on?".
describe("a human gate", () => {
  const answering = () =>
    ({
      createSession: async () => ({ id: "ses_gate" }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "here is the plan" }),
      interrupt: async () => undefined,
    }) as never

  test("the run holds after the gated task, and carries on when it is let through", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    // The scheduler drives the run, which is what makes "awaiting" reachable at all.
    Object.assign(scheduler, { engine: answering() })

    const run = await scheduler.runTasks({
      tasks: [
        { name: "plan", prompt: "Plan it", gate: "human" },
        { name: "implement", prompt: "Build it" },
      ],
    })
    await settledAt(repository, run.id, "awaiting")

    const tasks = repository.listTasks(run.id)
    expect(tasks.map((task) => `${task.name}:${task.status}`)).toEqual(["plan:success", "implement:queued"])
    // What it produced is readable while it waits — that is what there is to approve.
    expect(tasks[0]!.output).toBe("here is the plan")

    expect(scheduler.approve(run.id)?.status).toBe("running")
    await settledAt(repository, run.id, "success")
    expect(repository.listTasks(run.id).map((task) => task.status)).toEqual(["success", "success"])
    repository.close()
  })

  test("refusing it is stopping it, and what was queued never runs", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, { engine: answering() })

    const run = await scheduler.runTasks({
      tasks: [
        { name: "plan", prompt: "Plan it", gate: "human" },
        { name: "implement", prompt: "Build it" },
      ],
    })
    await settledAt(repository, run.id, "awaiting")

    await scheduler.stopRun(run.id)
    expect(repository.getRun(run.id)?.status).toBe("stopped")
    expect(repository.listTasks(run.id)[1]!.status).toBe("queued")
    // And approving after that changes nothing: the answer was already given.
    expect(scheduler.approve(run.id)).toBeUndefined()
    repository.close()
  })

  test("a run waiting at a gate is not history, so clearing the list leaves it", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, { engine: answering() })

    const run = await scheduler.runTasks({ tasks: [{ name: "plan", prompt: "Plan it", gate: "human" }] })
    await settledAt(repository, run.id, "awaiting")
    const over = repository.startRun(manual, 1000)
    repository.finishRun(over.id, "success")

    expect(repository.removeFinishedRuns()).toEqual([over.id])
    expect(repository.getRun(run.id)?.status).toBe("awaiting")
    repository.close()
  })
})
