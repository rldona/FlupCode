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

  test("the failures are filed on their lines, so the diff can show them", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-run-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      // Single-quoted, because the command itself is full of colons and YAML would end the scalar
      // at the first one — which is exactly the parse error this file reports when it happens.
      `verify:\n  typecheck: 'echo \"src/a.ts(4,7): error TS2322: Type number is not assignable.\"; exit 2'\n`,
    )

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify" }])
    await expect(new TaskRunner(repository, engine).execute(run, { directory })).rejects.toThrow()

    // This is the point of the ticket: a failed check becomes a comment on a line, through the same
    // machinery a review's findings go through.
    const [finding] = repository.listFindings({ runID: run.id })
    expect(finding).toMatchObject({
      file: "src/a.ts",
      line: 4,
      severity: "high",
      title: "Type number is not assignable.",
    })
    expect(finding!.detail).toContain("typecheck")
    expect(finding!.taskID).toBe(repository.listTasks(run.id)[0]!.id)
    repository.close()
  })

  test("a failure in a file outside the folder is not filed as a comment on it", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-run-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      `verify:\n  typecheck: 'echo \"/elsewhere/lib.ts(1,1): error TS2322: Not ours.\"; exit 2'\n`,
    )

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "verify", prompt: "", kind: "verify" }])
    await expect(new TaskRunner(repository, engine).execute(run, { directory })).rejects.toThrow()

    // There is no line in this diff to put it on. It stays in the evidence, which is read as text.
    expect(repository.listFindings({ runID: run.id })).toEqual([])
    expect(repository.listTasks(run.id)[0]!.output).toContain("/elsewhere/lib.ts")
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

  test("the retry is handed the failures, not the whole log", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-retry-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    // A check that prints one readable failure buried in a thousand characters of progress output,
    // which is what a test runner actually does.
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      `verify:\n  test: 'printf "%1000s" | tr " " "."; echo; echo \"src/a.ts(9,1): error TS2322: Broken.\"; exit 1'\n`,
    )

    const prompts: string[] = []
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "verify", prompt: "", kind: "verify", retries: 1 },
    ])
    await expect(
      new TaskRunner(repository, recordingEngine(prompts)).execute(run, { directory }),
    ).rejects.toThrow("Verification failed")

    expect(prompts[1]).toContain("src/a.ts:9 — Broken.")
    // The padding is what the retry used to be charged for, on every attempt.
    expect(prompts[1]).not.toContain("..........")
    // The evidence kept on the task is still the whole thing: the prompt is shortened, the record
    // is not.
    expect(repository.listTasks(run.id)[1]!.output).toContain("..........")
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

// H-47's other half. The harness has always passed `directory` to the engine; that says where to
// start, not where to stop. And a tool call with no ceiling holds a run to the thirty-minute cap.
describe("a task confined to its project", () => {
  const recordingSessions = (created: Array<Record<string, unknown>>) =>
    ({
      createSession: async (input: Record<string, unknown>) => {
        created.push(input)
        return { id: `ses_${created.length}` }
      },
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    }) as never

  test("the session is created denying anything outside the project", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-confine-"))
    scratch.push(directory)
    const created: Array<Record<string, unknown>> = []

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    await new TaskRunner(repository, recordingSessions(created)).execute(run, { directory })

    expect(created[0]!.permission).toEqual([{ permission: "external_directory", pattern: "*", action: "deny" }])
    repository.close()
  })

  test("a run that said it needs to reach outside is not confined", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-confine-"))
    scratch.push(directory)
    const created: Array<Record<string, unknown>> = []

    // Stated, not defaulted: H-04's rule is that policies only restrict and a bypass is explicit.
    const run = repository.startRun(manual, 1000, directory, { outside: true })
    repository.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    await new TaskRunner(repository, recordingSessions(created)).execute(run, { directory })

    expect(created[0]!.permission).toBeUndefined()
    repository.close()
  })

  test("the choice survives a run being picked up again at a gate", () => {
    // A run is driven twice, and an option that lived only in the request would stop applying at
    // the second entry — which is exactly when nobody is watching.
    const repository = open()
    const run = repository.startRun(manual, 1000, "/work", { outside: true, toolLimitMs: 600_000 })
    expect(repository.getRun(run.id)).toMatchObject({ outside: true, toolLimitMs: 600_000 })
    repository.close()
  })
})

describe("a ceiling on one tool call", () => {
  test("the run's ceiling is what the wait is given, and a run without one is not watched", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-limit-"))
    scratch.push(directory)
    const waits: Array<Record<string, unknown>> = []
    const engine = {
      createSession: async () => ({ id: "ses_1" }),
      prompt: async () => undefined,
      waitForIdle: async (_id: string, options: Record<string, unknown>) => void waits.push(options),
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const limited = repository.startRun(manual, 1000, directory, { toolLimitMs: 600_000 })
    repository.addTasks(limited.id, [{ name: "one", prompt: "do it" }])
    await new TaskRunner(repository, engine).execute(limited, { directory })
    expect(waits[0]!.toolLimitMs).toBe(600_000)

    const plain = repository.startRun(manual, 2000, directory)
    repository.addTasks(plain.id, [{ name: "one", prompt: "do it" }])
    await new TaskRunner(repository, engine).execute(plain, { directory })
    // No ceiling means no polling for one: it costs a request every few seconds.
    expect(waits[1]!.toolLimitMs).toBeUndefined()
    repository.close()
  })
})

describe("a run as a graph (H-28)", () => {
  test("independent tasks run at the same time", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-dag-"))
    scratch.push(directory)

    const started: string[] = []
    const settled: string[] = []
    let release!: () => void
    const both = new Promise<void>((resolve) => (release = resolve))
    const engine = {
      createSession: async () => ({ id: `ses_${started.length}` }),
      prompt: async (input: { text: string }) => {
        started.push(input.text)
        if (started.length === 2) release()
        // Wait for the other one: a sequential runner never reaches two and this times out.
        await Promise.race([both, Bun.sleep(2_000)])
        settled.push(`${input.text}:${started.length}`)
      },
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "left", prompt: "left", dependsOn: [] },
      { name: "right", prompt: "right", dependsOn: [] },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    // Both were in flight before either finished, which is the whole point of the DAG.
    expect(settled).toEqual(["left:2", "right:2"])
    expect(repository.listTasks(run.id).map((task) => task.status)).toEqual(["success", "success"])
    repository.close()
  })

  test("a task waits for the ones it names, even when they are written after it", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-dag-"))
    scratch.push(directory)
    const order: string[] = []
    const engine = {
      createSession: async () => ({ id: `ses_${order.length}` }),
      prompt: async (input: { text: string }) => void order.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "join", prompt: "join", dependsOn: ["left", "right"] },
      { name: "left", prompt: "left", dependsOn: [] },
      { name: "right", prompt: "right", dependsOn: [] },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    // The join is last because it waited for both, and it was handed both of their answers.
    expect(order.at(-1)).toContain("join")
    expect(order.at(-1)).toContain("Previous step")
    expect(order.at(-1)!.match(/done/g)).toHaveLength(2)
    expect(order.slice(0, 2).sort()).toEqual(["left", "right"])
    repository.close()
  })

  test("a `when` on a failed check runs the recovery, and the branch that expected success is skipped", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-dag-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), "verify:\n  test: exit 1\n")
    const order: string[] = []
    const engine = {
      createSession: async () => ({ id: `ses_${order.length}` }),
      prompt: async (input: { text: string }) => void order.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "build", prompt: "build", dependsOn: [] },
      { name: "check", prompt: "", kind: "verify", dependsOn: ["build"] },
      // The branch that only makes sense if the check passed must not run.
      { name: "ship", prompt: "ship", dependsOn: ["check"] },
      // The recovery declares the failure, so it runs and the run is allowed to reach it.
      { name: "explain", prompt: "explain", dependsOn: ["check"], when: { task: "check", is: ["failed"] } },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(repository.listTasks(run.id).map((task) => `${task.name}:${task.status}`)).toEqual([
      "build:success",
      "check:failed",
      "ship:skipped",
      "explain:success",
    ])
    expect(order).toEqual(["build", "explain"])
    // The skip says why, so a queued-looking row is never a mystery.
    expect(repository.listTasks(run.id)[2]!.error).toContain("did not succeed")
    repository.close()
  })

  test("a failed task leaves the work behind it queued, not skipped", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-dag-"))
    scratch.push(directory)
    const engine = {
      createSession: async () => ({ id: "ses_bad" }),
      prompt: async () => {
        throw new Error("the engine fell over")
      },
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "first", prompt: "first", dependsOn: [] },
      { name: "second", prompt: "second", dependsOn: ["first"] },
    ])
    await expect(new TaskRunner(repository, engine).execute(run, { directory })).rejects.toThrow(
      "the engine fell over",
    )
    expect(repository.listTasks(run.id).map((task) => task.status)).toEqual(["failed", "queued"])
    repository.close()
  })
})

describe("a foreach task (H-28)", () => {
  /** An engine whose planning task answers with a plan and whose other tasks answer "done". */
  const planningEngine = (answer: string, prompts: string[]) => {
    let calls = 0
    return {
      createSession: async () => ({ id: `ses_${prompts.length}` }),
      prompt: async (input: { text: string }) => void prompts.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: ++calls === 1 ? answer : "done" }),
    } as never
  }

  test("the plan becomes one task per step, and what follows waits for all of them", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-foreach-"))
    scratch.push(directory)
    const prompts: string[] = []

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it" },
      { name: "step", prompt: "Do: {{item}}", foreach: "plan" },
      { name: "after", prompt: "Finish" },
    ])
    await new TaskRunner(repository, planningEngine('```json\n["one", "two"]\n```', prompts)).execute(run, {
      directory,
    })

    const tasks = repository.listTasks(run.id)
    const named = (name: string) => tasks.filter((task) => task.name === name)
    // The marker plus one task per step, all sharing the name so a dependent waits for the fan-out.
    expect(named("plan").map((task) => task.status)).toEqual(["success"])
    expect(named("step").map((task) => task.status)).toEqual(["success", "success", "success"])
    expect(named("after").map((task) => task.status)).toEqual(["success"])
    expect(named("step")[0]!.output).toContain("1. one")
    expect(prompts).toContain("Do: one")
    expect(prompts).toContain("Do: two")
    // `after` is last, because it waited for every step, not just the marker.
    expect(prompts.at(-1)).toContain("Finish")
    repository.close()
  })

  test("a plan nobody wrote is not a failure, and adds nothing", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-foreach-"))
    scratch.push(directory)
    const prompts: string[] = []

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it" },
      { name: "step", prompt: "Do: {{item}}", foreach: "plan" },
    ])
    await new TaskRunner(repository, planningEngine("no block here", prompts)).execute(run, { directory })

    const tasks = repository.listTasks(run.id)
    expect(tasks.map((task) => `${task.name}:${task.status}`)).toEqual(["plan:success", "step:success"])
    expect(tasks[1]!.output).toContain("No steps")
    expect(prompts).toEqual(["Plan it"])
    repository.close()
  })
})

describe("context packs and handoffs (H-31)", () => {
  test("a run's packs reach a task as file parts, and the rest as text", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-packs-"))
    scratch.push(directory)
    mkdirSync(join(directory, "src"), { recursive: true })
    writeFileSync(join(directory, "src", "answers.ts"), "export const answers = 42\n")
    repository.savePack({ name: "ctx", refs: ["@src/answers.ts", "@artifact:report"], directory })

    const sent: Array<{ text: string; files?: Array<{ path: string }> }> = []
    const engine = {
      createSession: async () => ({ id: `ses_${sent.length}` }),
      prompt: async (input: { text: string; files?: Array<{ path: string }> }) =>
        void sent.push({ text: input.text, files: input.files }),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory, { packs: ["ctx"] })
    repository.addTasks(run.id, [{ name: "build", prompt: "Do it" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    // The file is a part the engine reads; the artifact is not a file, so it is said in the prompt.
    expect(sent[0]!.files?.map((file) => file.path)).toEqual([join(directory, "src", "answers.ts")])
    expect(sent[0]!.text).toContain("Context packs:")
    expect(sent[0]!.text).toContain("@artifact:report")
    repository.close()
  })

  test("a closing note is kept as an artifact and handed to the next task", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-handoff-"))
    scratch.push(directory)
    const prompts: string[] = []
    const engine = {
      createSession: async () => ({ id: `ses_${prompts.length}` }),
      prompt: async (input: { text: string }) => void prompts.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "The raw answer" }),
      handoff: async () => "Decided: use the server",
    } as never

    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "one", prompt: "First" },
      { name: "two", prompt: "Second" },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    const notes = repository.listArtifacts({ runID: run.id, kind: "handoff" })
    // One per agent task: the note after the last one is for whoever reads the run back.
    expect(notes).toHaveLength(2)
    expect(notes[0]!.content).toContain("Decided: use the server")
    // The next task is handed the note, not the whole answer.
    expect(prompts[1]).toContain("Decided: use the server")
    expect(prompts[1]).not.toContain("The raw answer")
    repository.close()
  })
})

describe("a run with worktrees (H-29)", () => {
  test("a task is given its own tree, and it is recorded on the task", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-worktrees-"))
    scratch.push(directory)
    const worktree = join(directory, "..", "flupcode-worktree-one")
    const prompts: Array<{ text: string; directory?: string }> = []
    const created: Array<{ directory?: string; name?: string }> = []
    const engine = {
      createWorktree: async (input: { directory?: string; name?: string }) => {
        created.push(input)
        return { name: input.name ?? "task", directory: worktree }
      },
      createSession: async () => ({ id: "ses_one" }),
      prompt: async (input: { text: string; directory?: string }) => void prompts.push(input),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory, { worktrees: true })
    repository.addTasks(run.id, [{ name: "Find the bug", prompt: "Do it" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    // A slug the engine can turn into a folder and a branch, not the task's spaces.
    expect(created).toEqual([{ directory, name: "find-the-bug" }])
    expect(prompts[0]!.directory).toBe(worktree)
    expect(repository.listTasks(run.id)[0]!.directory).toBe(worktree)
    repository.close()
  })

  test("a run that did not ask for them does not create one", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-noworktrees-"))
    scratch.push(directory)
    let asked = 0
    const engine = {
      createWorktree: async () => {
        asked++
        return { name: "task", directory }
      },
      createSession: async () => ({ id: "ses_one" }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [{ name: "one", prompt: "go" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(asked).toBe(0)
    repository.close()
  })
})

describe("a run's model policy (H-30)", () => {
  test("a task runs on the model the policy names for its role", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-policy-"))
    scratch.push(directory)
    const sent: Array<{ model?: { providerID: string; id: string } }> = []
    const engine = {
      createSession: async () => ({ id: "ses_one" }),
      prompt: async (input: { model?: { providerID: string; id: string } }) => void sent.push({ model: input.model }),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory, { policy: { models: { build: "anthropic/claude" } } })
    repository.addTasks(run.id, [
      { name: "build", prompt: "go", agent: "build" },
      { name: "plan", prompt: "go", agent: "plan" },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(sent[0]!.model).toEqual({ providerID: "anthropic", id: "claude" })
    // A role the policy does not name is left to the engine's own default.
    expect(sent[1]!.model).toBeUndefined()
    repository.close()
  })

  test("a retry falls back to the model the policy names", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-fallback-"))
    scratch.push(directory)
    writeFileSync(join(directory, "broken"), "yes")
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      "verify:\n  test: test ! -f broken || { echo 'still broken' >&2; exit 1; }\n",
    )
    let attempts = 0
    const engine = {
      createSession: async () => ({ id: `ses_${attempts}` }),
      prompt: async () => {
        attempts++
        // The second attempt fixes it, so the run can finish rather than throwing.
        if (attempts > 1) rmSync(join(directory, "broken"))
      },
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory, { policy: { fallback: "a/backup" } })
    repository.addTasks(run.id, [
      { name: "build", prompt: "go" },
      { name: "verify", prompt: "", kind: "verify", retries: 1 },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    const retry = repository.listTasks(run.id).find((task) => task.name === "build" && task.attempt === 2)
    expect(retry?.model).toEqual({ providerID: "a", id: "backup" })
    repository.close()
  })

  test("a run stops at its budget, and carries on when it is let through", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-budget-"))
    scratch.push(directory)
    const engine = {
      createSession: async () => ({ id: "ses_one" }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done", tokens: 100, cost: 0.5 }),
    } as never
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, { engine })

    const run = await scheduler.runTasks({
      tasks: [
        { name: "one", prompt: "a" },
        { name: "two", prompt: "b" },
      ],
      directory,
      policy: { budget: { tokens: 50 } },
    })
    await settledAt(repository, run.id, "awaiting")

    expect(repository.getRun(run.id)!.paused).toBe("budget")
    expect(repository.listTasks(run.id)[1]!.status).toBe("queued")

    scheduler.approve(run.id)
    await settledAt(repository, run.id, "success")
    expect(repository.getRun(run.id)!.budgetApproved).toBe(true)
    repository.close()
  })
})

describe("project memory in a run (H-37)", () => {
  test("the project's notes are handed to a task", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-memory-"))
    scratch.push(directory)
    repository.addProjectMemory({ directory, text: "Use the server, not the browser" })

    const sent: string[] = []
    const engine = {
      createSession: async () => ({ id: "ses_one" }),
      prompt: async (input: { text: string }) => void sent.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [{ name: "one", prompt: "Do it" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(sent[0]).toContain("Project memory:")
    expect(sent[0]).toContain("Use the server, not the browser")
    // And a project with no notes says nothing about memory.
    const other = mkdtempSync(join(tmpdir(), "flupcode-nomemory-"))
    scratch.push(other)
    const empty: string[] = []
    const engine2 = {
      createSession: async () => ({ id: "ses_two" }),
      prompt: async (input: { text: string }) => void empty.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never
    const run2 = repository.startRun(manual, 1000, other)
    repository.addTasks(run2.id, [{ name: "one", prompt: "Do it" }])
    await new TaskRunner(repository, engine2).execute(run2, { directory: other })
    expect(empty[0]).not.toContain("Project memory:")
    repository.close()
  })
})
