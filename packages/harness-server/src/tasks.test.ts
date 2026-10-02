import { afterAll, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTICE, createBrowserPolicy } from "./browser-policy"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner, resumePoint } from "./runner"
import { handleUsageRead } from "./usage"
import { RoutineScheduler } from "./scheduler"
import { ActionRunError, createActionRunner } from "./action-runner"
import { unavailableActionCredentialResolver } from "./action-credentials"
import type { ActionCatalogProfile, ActionRunResult, ActionRunner, ActionRunRequest } from "./action-runner"
import { BrowserError } from "./browser"
import type { BrowserRuntime } from "./browser"
import type { BrowserAllowRule, RunSource, RunStatus } from "./types"

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
    // How it ended is its verdict (UX-04): nothing checked the answer, so it is not "success".
    expect(report?.title).toBe("Run not verified")
    expect(report?.content).toContain("Run not verified in")
    expect(report?.content).toContain("- build — success")
    // The totals §6.3 wanted in the run's session, which the engine cannot be asked for free.
    expect(report?.content).toContain("1 tasks, 120 tokens, $0.0200")
    repository.close()
  })

  // UX-04: the report of a run whose work failed is not titled "success" next to a failed verdict.
  test("a run whose agent gave up is reported as failed, in the agent's words", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const reason = "I cannot do this without the vendor API key, so I stop here."
    Object.assign(scheduler, {
      engine: {
        createSession: async () => ({ id: "ses_a" }),
        prompt: async () => undefined,
        waitForIdle: async () => undefined,
        lastAnswer: async () => ({ text: `I read the parser.\n\n${reason}`, tokens: 120, cost: 0.02 }),
      },
    })

    const run = await scheduler.runTasks({ tasks: [{ name: "build", prompt: "Do it" }] })
    await settledAt(repository, run.id, "success")

    expect(repository.getRun(run.id)?.verdict?.value).toBe("failed")
    const [report] = repository.listArtifacts({ runID: run.id, kind: "report" })
    expect(report?.title).toBe("Run failed")
    expect(report?.content).toContain(`build: ${reason}`)
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

  test("a run with no shell is denied the bash tool as well", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-noshell-"))
    scratch.push(directory)
    const created: Array<Record<string, unknown>> = []

    const run = repository.startRun(manual, 1000, directory, { shell: false })
    repository.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    await new TaskRunner(repository, recordingSessions(created)).execute(run, { directory })

    expect(created[0]!.permission).toEqual([
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
    repository.close()
  })

  test("the choice survives a run being picked up again at a gate", () => {
    // A run is driven twice, and an option that lived only in the request would stop applying at
    // the second entry — which is exactly when nobody is watching.
    const repository = open()
    const run = repository.startRun(manual, 1000, "/work", { outside: true, shell: false, toolLimitMs: 600_000 })
    expect(repository.getRun(run.id)).toMatchObject({ outside: true, shell: false, toolLimitMs: 600_000 })
    repository.close()
  })
})

// H-38: another vendor's CLI as the executor of a task. The engine must not be touched at all: the
// command runs, what it printed is the task's answer, and a later task is handed it like any other.
describe("a task an external command runs", () => {
  const neverEngine = new Proxy({} as never, {
    get(_target, name) {
      throw new Error(`the runner asked the engine for ${String(name)} during an external task`)
    },
  })

  const scratchDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-external-"))
    scratch.push(directory)
    return directory
  }

  test("runs in the task's tree, keeps what it printed, and takes its point", async () => {
    const repository = open()
    const directory = scratchDirectory()
    // A repository, so the point taken after the task has somewhere to live.
    await Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: directory, stdout: "pipe", stderr: "pipe" }).exited
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "codex", prompt: "do it", kind: "external", command: "echo hello from the vendor" },
    ])
    await new TaskRunner(repository, neverEngine).execute(run, { directory })

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "success", output: "hello from the vendor\n" })
    // The point after it exists, like after any task that may have written files.
    expect(repository.listCheckpoints({ runID: run.id })).toHaveLength(1)
    repository.close()
  })

  test("a command that fails fails the run, and what it printed is kept", async () => {
    const repository = open()
    const directory = scratchDirectory()
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "codex", prompt: "", kind: "external", command: "echo nope >&2; exit 4" },
    ])
    const runner = new TaskRunner(repository, neverEngine)
    await expect(runner.execute(run, { directory })).rejects.toThrow("The external command exited 4")

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "failed", error: "The external command exited 4" })
    expect(task!.output).toContain("nope")
    repository.close()
  })

  test("the prompt reaches the command, quoted", async () => {
    const repository = open()
    const directory = scratchDirectory()
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "codex", prompt: "don't stop", kind: "external", command: "printf %s {{prompt}}" },
    ])
    await new TaskRunner(repository, neverEngine).execute(run, { directory })
    expect(repository.listTasks(run.id)[0]!.output).toBe("don't stop")
    repository.close()
  })

  // TI-06: a plan's steps are model text. Substituted raw into a command run by `sh -lc`, one step
  // could run anything; quoted, each is one argument whatever it contains.
  test("a step of a plan reaches the command as one argument, never as shell syntax", async () => {
    const repository = open()
    const directory = scratchDirectory()
    const marker = join(directory, "pwned")
    const steps = [
      `a; touch ${marker}`,
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `line\ntouch ${marker}`,
      `it's "quoted"`,
    ]
    const plan = `\`\`\`json\n${JSON.stringify(steps)}\n\`\`\``
    const planning = {
      createSession: async () => ({ id: "ses_plan" }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: plan }),
    } as never
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it" },
      { name: "step", prompt: "", kind: "external", command: "printf '%s|' {{item}}", foreach: "plan" },
    ])
    expect(await new TaskRunner(repository, planning).execute(run, { directory })).toBe("done")

    expect(existsSync(marker)).toBe(false)
    const outputs = repository
      .listTasks(run.id)
      .filter((task) => task.name === "step" && task.kind === "external" && !task.foreach)
      .map((task) => task.output)
    expect(outputs).toEqual(steps.map((step) => `${step}|`))
    repository.close()
  })

  test("a run that is stopped kills the command and finishes as stopped", async () => {
    const repository = open()
    const directory = scratchDirectory()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, { engine: neverEngine })

    const run = await scheduler.runTasks({
      tasks: [{ name: "codex", prompt: "", kind: "external", command: "sleep 30" }],
      directory,
    })
    await scheduler.stopRun(run.id)
    await settledAt(repository, run.id, "stopped")
    expect(repository.listTasks(run.id)[0]!.status).toBe("stopped")
    repository.close()
  })
})

// TI-02: a session that went quiet is not a task that succeeded. What the engine said went wrong
// is the task's error, and what the turn spent is kept whether it worked or not.
describe("a turn the engine failed", () => {
  const engineAnswering = (answer: Record<string, unknown>, options: { busy?: Error } = {}) =>
    ({
      createSession: async () => ({ id: "ses_1" }),
      prompt: async () => undefined,
      waitForIdle: async () => {
        if (options.busy) throw options.busy
      },
      lastAnswer: async () => answer,
    }) as never

  test("fails the task with the engine's error, keeps its cost, and runs nothing after it", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Write the plan" },
      { name: "build", prompt: "Do it", dependsOn: ["plan"] },
    ])
    const engine = engineAnswering({ tokens: 12, cost: 0.003, error: "Rate limit reached for requests" })
    await expect(new TaskRunner(repository, engine).execute(run)).rejects.toThrow("Rate limit reached")

    const [plan, build] = repository.listTasks(run.id)
    expect(plan).toMatchObject({ status: "failed", error: "Rate limit reached for requests", tokens: 12, cost: 0.003 })
    expect(build!.status).toBe("queued")
    repository.close()
  })

  test("a turn cut short by its timeout still keeps what it spent", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "slow", prompt: "Take long" }])
    const engine = engineAnswering(
      { text: "half", tokens: 40, cost: 0.01 },
      { busy: new Error("The work was still running after 30 minutes") },
    )
    await expect(new TaskRunner(repository, engine).execute(run)).rejects.toThrow("still running")

    expect(repository.listTasks(run.id)[0]).toMatchObject({ status: "failed", tokens: 40, cost: 0.01 })
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

  test("HF-6: an artifact ref in a pack reaches the task as its content", async () => {
    const repository = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-packs-"))
    scratch.push(directory)
    const artifact = repository.addArtifact({
      kind: "verdict",
      title: "verify — passed",
      producer: "harness",
      content: "Verification: passed",
      directory,
    })
    repository.savePack({ name: "ctx", refs: [`@artifact:${artifact.id}`], directory })

    const sent: string[] = []
    const engine = {
      createSession: async () => ({ id: `ses_${sent.length}` }),
      prompt: async (input: { text: string }) => void sent.push(input.text),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "done" }),
    } as never

    const run = repository.startRun(manual, 1000, directory, { packs: ["ctx"] })
    repository.addTasks(run.id, [{ name: "build", prompt: "Do it" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(sent[0]).toContain("--- verify — passed (verdict) ---")
    expect(sent[0]).toContain("Verification: passed")
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

// WA-7: a scheduled web action is a normal Run with a deterministic `action` task. The runner
// calls the action runner in process, so no model turn is spent — and without the consent the
// routine declared, it fails closed before any browser opens.
describe("a web action task (WA-7)", () => {
  const engine = new Proxy({} as never, {
    get(_target, name) {
      throw new Error(`the runner asked the engine for ${String(name)} during an action task`)
    },
  })

  const publishProfile = (): ActionCatalogProfile => ({
    id: "publish",
    tool: "do_publish",
    description: "Publish the piece",
    kind: "browser",
    origin: "https://example.com",
    inputs: { text: "string" },
    steps: [],
    guards: [],
    sensitive: true,
    availability: "host",
    evidence: {},
    scope: "global",
  })

  const allowed: BrowserAllowRule[] = [
    { permission: "browser_sensitive", pattern: "https://example.com:publish", action: "allow" },
  ]

  const actionRunner = (run?: (request: ActionRunRequest) => Promise<ActionRunResult>) => {
    const calls: ActionRunRequest[] = []
    const runner: ActionRunner = {
      list: () => ({ profiles: [publishProfile()], rejected: [] }),
      policy: createBrowserPolicy(new SqliteRoutineRepository(":memory:")),
      run: async (request) => {
        calls.push(request)
        if (run) return run(request)
        return {
          action: "publish",
          tool: "do_publish",
          status: "success",
          origin: "https://example.com",
          url: "https://example.com/done",
          title: "Done",
          startedAt: 0,
          finishedAt: 1,
          steps: [],
          evidence: [],
          notice: UNTRUSTED_NOTICE,
        }
      },
    }
    return { runner, calls }
  }

  const addPublish = (repository: SqliteRoutineRepository, runID: string) =>
    repository.addTasks(runID, [
      { name: "publish", prompt: "", kind: "action", action: { id: "publish", inputs: { text: "hola" } } },
    ])

  // The real runner over a stand-in browser that does what it is told, so the policy and the audit
  // run as in production (BU-01).
  const policedRunner = (repository: SqliteRoutineRepository, origin = "https://example.com") => {
    const browser = new Proxy({} as BrowserRuntime, {
      get: (_target, name) => async () => {
        if (name === "screenshot") return { artifactId: "art_shot" }
        if (name === "navigate") return { url: `${origin}/`, title: "Home" }
        return undefined
      },
    })
    return createActionRunner({
      browser,
      policy: createBrowserPolicy(repository),
      repository,
      credentials: unavailableActionCredentialResolver,
      loadProfiles: () => ({
        configDir: "/nonexistent",
        profiles: { publish: { tool: "do_publish", kind: "browser", origin, inputs: { text: "string" }, steps: [{ goto: "{{origin}}/" }], sensitive: true } },
        scopes: {},
        guardDirs: {},
      }),
    })
  }

  test("a scheduled action is decided by the policy, and what it did is in its run's log (BU-01)", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await new TaskRunner(repository, engine, policedRunner(repository)).execute(run)

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "success" })
    expect(
      repository
        .listBrowserAudit({ runID: run.id })
        .reverse()
        .map((entry) => [entry.kind, entry.decision ?? entry.outcome, entry.tier, entry.taskID, entry.artifactID, entry.reason]),
    ).toEqual([
      ["decision", "allow", "sensitive", task!.id, undefined, "The routine's allow rule covers it"],
      ["action", "success", "sensitive", task!.id, "art_shot", undefined],
    ])
    expect(
      repository.listEvents(0, 500).filter((stored) => stored.event.type === "browser.audit" && stored.event.entry.runID === run.id),
    ).toHaveLength(2)
    repository.close()
  })

  test("a scheduled action on a payment or sign-in site fails before the browser opens, whatever it allows (BU-01)", async () => {
    const repository = open()
    const origin = "https://www.paypal.com"
    const run = repository.startRun(manual, 1000, undefined, {
      allow: [{ permission: "browser_sensitive", pattern: `${origin}:publish`, action: "allow" }],
    })
    addPublish(repository, run.id)

    await expect(new TaskRunner(repository, engine, policedRunner(repository, origin)).execute(run)).rejects.toThrow(
      /payment or banking site/,
    )
    expect(repository.listBrowserAudit({ runID: run.id }).map((entry) => [entry.kind, entry.decision])).toEqual([
      ["decision", "deny"],
    ])
    repository.close()
  })

  test("without an allow rule it fails closed and never calls the action runner", async () => {
    const repository = open()
    const { runner, calls } = actionRunner()
    const run = repository.startRun(manual, 1000)
    addPublish(repository, run.id)

    await expect(new TaskRunner(repository, engine, runner).execute(run)).rejects.toThrow(/allow rule/)

    expect(calls).toHaveLength(0)
    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "failed" })
    expect(task!.error).toContain("https://example.com:publish")
    repository.close()
  })

  test("with the allow rule it runs and its evidence is bound to the run and task", async () => {
    const repository = open()
    const { runner, calls } = actionRunner(async (request) => {
      repository.addArtifact({
        kind: "screenshot",
        title: "shot",
        producer: "harness",
        path: "frames/x.png",
        directory: "/tmp",
        ...(request.runID ? { runID: request.runID } : {}),
        ...(request.taskID ? { taskID: request.taskID } : {}),
      })
      return {
        action: "publish",
        tool: "do_publish",
        status: "success",
        origin: "https://example.com",
        url: "https://example.com/done",
        title: "Done",
        startedAt: 0,
        finishedAt: 1,
        steps: [],
        evidence: [],
        notice: UNTRUSTED_NOTICE,
      }
    })
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await new TaskRunner(repository, engine, runner).execute(run)

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "success" })
    expect(calls[0]).toMatchObject({
      action: "publish",
      sessionID: task!.id,
      runID: run.id,
      taskID: task!.id,
      closeOnFinish: true,
    })
    const [artifact] = repository.listArtifacts({ runID: run.id }).filter((entry) => entry.taskID === task!.id)
    expect(artifact).toMatchObject({ kind: "screenshot", runID: run.id, taskID: task!.id })
    repository.close()
  })

  test("a recipe that fails records the failure on the run, with a log", async () => {
    const repository = open()
    const { runner } = actionRunner(async () => {
      throw new ActionRunError({ code: "step_failed", status: 422, message: "the button was missing", action: "publish" })
    })
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await expect(new TaskRunner(repository, engine, runner).execute(run)).rejects.toThrow("the button was missing")

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "failed", error: "the button was missing" })
    const [log] = repository.listArtifacts({ runID: run.id, kind: "log" })
    expect(log?.content).toBe("the button was missing")
    repository.close()
  })

  test("a stop is not a failure: the task is stopped and the run carries no error", async () => {
    const repository = open()
    const { runner } = actionRunner(async () => {
      throw new ActionRunError({ code: "stopped", status: 409, message: "The run was stopped", action: "publish" })
    })
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await new TaskRunner(repository, engine, runner).execute(run)

    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "stopped", error: "The run was stopped" })
    repository.close()
  })

  test("a browser stop the scheduler did not ask for closes the run as stopped", async () => {
    const repository = open()
    const { runner } = actionRunner(async () => {
      throw new ActionRunError({
        code: "stopped",
        status: 409,
        message: "The browser session was stopped",
        action: "publish",
      })
    })
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1", actions: runner })
    const routine = repository.create({
      name: "Publish",
      description: "",
      prompt: "",
      schedule: { type: "manual" },
      action: { id: "publish", inputs: { text: "hola" } },
      allow: allowed,
    })

    const run = await scheduler.runNow(routine.id)
    await settledAt(repository, run.id, "stopped")

    expect(repository.getRun(run.id)?.status).toBe("stopped")
    expect(repository.listTasks(run.id)[0]).toMatchObject({ status: "stopped" })
    repository.close()
  })

  test("a project whose browser is busy is waited out before the recipe runs", async () => {
    const repository = open()
    const { runner, calls } = actionRunner(async () => {
      if (calls.length < 3) throw new BrowserError("browser_busy", 409, "This project already has a browser session")
      return {
        action: "publish",
        tool: "do_publish",
        status: "success",
        origin: "https://example.com",
        url: "https://example.com/done",
        title: "Done",
        startedAt: 0,
        finishedAt: 1,
        steps: [],
        evidence: [],
        notice: UNTRUSTED_NOTICE,
      }
    })
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await new TaskRunner(repository, engine, runner).execute(run)

    expect(calls).toHaveLength(3)
    expect(repository.listTasks(run.id)[0]).toMatchObject({ status: "success" })
    repository.close()
  })

  test("a project still busy after the retries fails with an actionable reason", async () => {
    const repository = open()
    const { runner, calls } = actionRunner(async () => {
      throw new BrowserError("browser_busy", 409, "This project already has a browser session")
    })
    const run = repository.startRun(manual, 1000, undefined, { allow: allowed })
    addPublish(repository, run.id)

    await expect(new TaskRunner(repository, engine, runner).execute(run)).rejects.toThrow(/busy with another action/)

    expect(calls).toHaveLength(3)
    const [task] = repository.listTasks(run.id)
    expect(task).toMatchObject({ status: "failed" })
    expect(task!.error).toContain("busy")
    repository.close()
  })

  test("a routine that drives an action starts the run with the task and its allow rules", async () => {
    const repository = open()
    const { runner, calls } = actionRunner()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1", actions: runner })
    const routine = repository.create({
      name: "Publish",
      description: "",
      prompt: "",
      schedule: { type: "manual" },
      action: { id: "publish", inputs: { text: "hola" } },
      allow: allowed,
    })

    const run = await scheduler.runNow(routine.id)
    await settledAt(repository, run.id, "success")

    expect(repository.getRun(run.id)?.allow).toEqual(allowed)
    expect(repository.listTasks(run.id)[0]).toMatchObject({
      kind: "action",
      action: { id: "publish", inputs: { text: "hola" } },
    })
    expect(calls).toHaveLength(1)
    repository.close()
  })
})

// TI-03: a run that pauses and is picked up again — at a gate, after a budget stop, after a restart or
// through a retry — hands its tasks the same notes and trees as one that never paused.
describe("a run picked up again", () => {
  const recording = (prompts: Array<{ text: string; directory?: string }>, worktree?: (name: string) => string) =>
    ({
      ...(worktree
        ? { createWorktree: async (input: { name?: string }) => ({ name: input.name, directory: worktree(input.name ?? "task") }) }
        : {}),
      createSession: async () => ({ id: `ses_${prompts.length}` }),
      prompt: async (input: { text: string; directory?: string }) => void prompts.push(input),
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "Plan: change the parser" }),
      handoff: async (input: { task: string }) => `Handoff from ${input.task}: change the parser`,
      interrupt: async () => undefined,
    }) as never

  test("after a gate, the next task is handed the gated task's note", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const prompts: Array<{ text: string; directory?: string }> = []
    Object.assign(scheduler, { engine: recording(prompts) })

    const run = await scheduler.runTasks({
      tasks: [
        { name: "plan", prompt: "Plan it", gate: "human" },
        { name: "implement", prompt: "Build it" },
      ],
    })
    await settledAt(repository, run.id, "awaiting")
    scheduler.approve(run.id)
    await settledAt(repository, run.id, "success")

    expect(prompts.map((prompt) => prompt.text.includes("Build it"))).toEqual([false, true])
    expect(prompts[1]!.text).toContain("Handoff from plan: change the parser")
    repository.close()
  })

  // A real folder per tree with a check of its own: a check works in the tree it checks, and its
  // verdict records where that was.
  const trees = (base: string) => {
    const made = new Map<string, string>()
    return (name: string) => {
      if (!made.has(name)) {
        const tree = realpathSync(mkdtempSync(join(base, `${name}-`)))
        mkdirSync(join(tree, ".flupcode"))
        writeFileSync(join(tree, ".flupcode", "project.yaml"), "verify:\n  where: pwd\n")
        made.set(name, tree)
      }
      return made.get(name)!
    }
  }

  test("after a restart, a fresh runner hands on the note and the tree the gated task left", async () => {
    const repository = open()
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-resume-")))
    scratch.push(directory)
    const prompts: Array<{ text: string; directory?: string }> = []
    const tree = trees(directory)

    const run = repository.startRun(manual, 1000, directory, { worktrees: true })
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it", gate: "human" },
      { name: "implement", prompt: "Build it", dependsOn: ["plan"] },
      { name: "check", prompt: "", kind: "verify", dependsOn: ["plan"] },
    ])
    expect(await new TaskRunner(repository, recording(prompts, tree)).execute(run, { directory })).toBe("paused")
    repository.resumeRun(run.id)
    // Another process: nothing survives but the database.
    await new TaskRunner(repository, recording(prompts, tree)).execute(repository.getRun(run.id)!, { directory })

    expect(prompts.find((prompt) => prompt.text.includes("Build it"))!.text).toContain(
      "Handoff from plan: change the parser",
    )
    // The check's own verdict (agent tasks keep one too since RP-06).
    const checks = new Set(repository.listTasks(run.id).flatMap((task) => (task.kind === "verify" ? [task.id] : [])))
    const verdict = repository
      .listArtifacts({ runID: run.id, kind: "verdict" })
      .filter((artifact) => checks.has(artifact.taskID ?? ""))
    expect(verdict.map((artifact) => artifact.directory)).toEqual([tree("plan")])
    repository.close()
  })

  test("a retried task gets its predecessor's note, and a retried check runs in the tree it checks", async () => {
    const repository = open()
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-retry-")))
    scratch.push(directory)
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const prompts: Array<{ text: string; directory?: string }> = []
    const tree = trees(directory)
    Object.assign(scheduler, { engine: recording(prompts, tree) })

    const run = await scheduler.runTasks({
      directory,
      worktrees: true,
      tasks: [
        { name: "plan", prompt: "Plan it" },
        { name: "implement", prompt: "Build it", dependsOn: ["plan"] },
        { name: "check", prompt: "", kind: "verify", dependsOn: ["implement"] },
      ],
    })
    await settledAt(repository, run.id, "success")
    for (const name of ["check", "implement"]) {
      scheduler.retryTask(repository.listTasks(run.id).find((task) => task.name === name)!.id)
      await settledAt(repository, run.id, "success")
    }

    const built = prompts.filter((prompt) => prompt.text.includes("Build it"))
    expect(built).toHaveLength(2)
    expect(built[1]!.text).toContain("Handoff from plan: change the parser")
    // The checks' own verdicts (agent tasks keep one too since RP-06).
    const checks = new Set(repository.listTasks(run.id).flatMap((task) => (task.kind === "verify" ? [task.id] : [])))
    const verdicts = repository
      .listArtifacts({ runID: run.id, kind: "verdict" })
      .filter((artifact) => checks.has(artifact.taskID ?? ""))
    expect(verdicts.map((artifact) => artifact.directory)).toEqual([tree("implement"), tree("implement")])
    repository.close()
  })
})

// RP-06: every agent task is judged by something other than the agent that did it, and the run's
// verdict is its worst task's.
describe("a task's verdict", () => {
  /** An engine whose tasks answer in turn, from the list given. */
  const answering = (answers: string[]) => {
    let turn = 0
    return {
      createSession: async () => ({ id: `ses_${turn}` }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: answers[turn++] ?? "", tokens: 5, cost: 0.001 }),
    } as never
  }

  const project = (verify: string) => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-verdict-"))
    scratch.push(directory)
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), `verify:\n  test: ${verify}\n`)
    return directory
  }

  test("an agent that gives up ends its task with a failed verdict in its own words, and the run with it", async () => {
    const repository = open()
    const run = repository.startRun({ type: "routine", routineID: "nightly" }, 1000)
    repository.addTasks(run.id, [{ name: "fix", prompt: "Fix the parser" }])
    expect(await new TaskRunner(repository, answering(["Tried twice. I stop here: the fixture is missing."])).execute(run)).toBe(
      "done",
    )

    const [task] = repository.listTasks(run.id)
    // The turn itself ended cleanly, so the task is not failed; the verdict says the goal was not met.
    expect(task!.status).toBe("success")
    expect(task!.verdict).toEqual({ value: "failed", reason: "I stop here: the fixture is missing.", source: "rule" })
    expect(repository.getRun(run.id)?.verdict).toEqual({ ...task!.verdict!, taskID: task!.id })
    // The routine's run reads the same, and so does the stream the app follows.
    expect(repository.listRuns({ type: "routine", routineID: "nightly" })[0]?.verdict?.value).toBe("failed")
    const changed = repository
      .listEvents(0)
      .flatMap((entry) => (entry.event.type === "run.changed" ? [entry.event.run.verdict?.value] : []))
    expect(changed.at(-1)).toBe("failed")
    const [artifact] = repository.listArtifacts({ runID: run.id, kind: "verdict" })
    expect(artifact).toMatchObject({ title: "fix — failed", content: "I stop here: the fixture is missing.", taskID: task!.id })
    repository.close()
  })

  test("an answer that ends asking the person needs the user", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "migrate", prompt: "Migrate it" }])
    await new TaskRunner(repository, answering(["Two databases are configured. Which one should I migrate?"])).execute(run)

    expect(repository.listTasks(run.id)[0]!.verdict).toEqual({
      value: "needs-user",
      reason: "Which one should I migrate?",
      source: "rule",
    })
    repository.close()
  })

  test("a passing check verifies itself and the work it checked", async () => {
    const repository = open()
    const directory = project("echo ok")
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Build it" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    await new TaskRunner(repository, answering(["Built it."])).execute(run, { directory })

    const verdicts = repository.listTasks(run.id).map((task) => task.verdict)
    expect(verdicts).toEqual([
      { value: "verified", reason: "Verification passed: test", source: "check" },
      { value: "verified", reason: "Verification passed: test", source: "check" },
    ])
    expect(repository.getRun(run.id)?.verdict?.value).toBe("verified")
    // The rule's verdict is kept beside the check's, not overwritten by it.
    const build = repository.listTasks(run.id)[0]!
    const titles = repository
      .listArtifacts({ runID: run.id, kind: "verdict" })
      .filter((artifact) => artifact.taskID === build.id)
      .map((artifact) => artifact.title)
    expect(titles.sort()).toEqual(["build — unverified", "build — verified"])
    repository.close()
  })

  test("a passing check does not turn an agent that gave up into verified work", async () => {
    const repository = open()
    const directory = project("echo ok")
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Build it" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    await new TaskRunner(repository, answering(["I cannot complete this without the API key."])).execute(run, { directory })

    expect(repository.listTasks(run.id).map((task) => task.verdict?.value)).toEqual(["failed", "verified"])
    expect(repository.getRun(run.id)?.verdict).toMatchObject({ value: "failed", source: "rule" })
    repository.close()
  })

  test("a failed check fails the work, and a retry that passes leaves the run verified", async () => {
    const repository = open()
    const directory = project("test ! -f broken || { echo 'still broken' >&2; exit 1; }")
    writeFileSync(join(directory, "broken"), "yes")
    let turn = 0
    const engine = {
      createSession: async () => ({ id: `ses_${turn}` }),
      prompt: async () => {
        turn++
        if (turn > 1) rmSync(join(directory, "broken"))
      },
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "Fixed it." }),
    } as never
    const run = repository.startRun(manual, 1000, directory)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "check", prompt: "", kind: "verify", retries: 1 },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(repository.listTasks(run.id).map((task) => `${task.name}#${task.attempt}:${task.verdict?.value}`)).toEqual([
      "build#1:failed",
      "check#1:failed",
      "build#2:verified",
      "check#2:verified",
    ])
    expect(repository.listTasks(run.id)[0]!.verdict).toEqual({
      value: "failed",
      reason: "Verification failed: test",
      source: "check",
    })
    expect(repository.getRun(run.id)?.verdict?.value).toBe("verified")
    repository.close()
  })

  test("a turn the engine failed is a failed verdict", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "plan", prompt: "Plan" }])
    const engine = {
      createSession: async () => ({ id: "ses_1" }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ error: "Invalid API key provided" }),
    } as never
    await expect(new TaskRunner(repository, engine).execute(run)).rejects.toThrow("Invalid API key")
    expect(repository.getRun(run.id)?.verdict).toMatchObject({ value: "failed", reason: "Invalid API key provided" })
    repository.close()
  })

  test("by default a verdict does not block what follows", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan" },
      { name: "build", prompt: "Build" },
    ])
    await new TaskRunner(repository, answering(["I give up.", "Built it."])).execute(run)
    expect(repository.listTasks(run.id).map((task) => `${task.status}:${task.verdict?.value}`)).toEqual([
      "success:failed",
      "success:unverified",
    ])
    repository.close()
  })

  test("`require: verified` runs a task only after verified work, and skips it otherwise", async () => {
    const gated = async (verify: string) => {
      const repository = open()
      const directory = project(verify)
      const run = repository.startRun(manual, 1000, directory)
      repository.addTasks(run.id, [
        { name: "build", prompt: "Build it" },
        { name: "check", prompt: "", kind: "verify" },
        { name: "unchecked", prompt: "Ship it", dependsOn: ["build"], require: "verified" },
        { name: "ship", prompt: "Ship it", dependsOn: ["check"], require: "verified" },
      ])
      await new TaskRunner(repository, answering(["Built it.", "Shipped.", "Shipped."]))
        .execute(run, { directory })
        .catch(() => undefined)
      const tasks = repository.listTasks(run.id)
      repository.close()
      return tasks
    }

    // `unchecked` is decided as soon as `build` is done, before the check has run on it: unverified.
    const passing = await gated("echo ok")
    expect(passing.map((task) => `${task.name}:${task.status}`)).toEqual([
      "build:success",
      "check:success",
      "unchecked:skipped",
      "ship:success",
    ])
    expect(passing[2]!.error).toBe("Not run: build was not verified")
    // A failed check ends the run before anything behind it; `ship` never starts.
    const failing = await gated("exit 1")
    expect(failing.find((task) => task.name === "ship")!.status).not.toBe("success")
  })
})

// RP-04: a run that failed, was stopped or lost its process picks up where it broke, or from a task
// somebody chose, and runs only what had not succeeded. The folder goes back to how it looked before
// that task first ran, so the run behaves as if it had never stopped.
describe("resuming a run from a task", () => {
  const steps = ["one", "two", "three", "four"]
  const prompt = (name: string) => `Do ${name}`

  /**
   * A git folder and an engine whose tasks each write a file named after them. The task named in
   * `failing` writes its file and then fails, once; `hanging` never comes back, as a lost process.
   */
  const stack = (options: { failing?: string; hanging?: string } = {}) => {
    const repository = open()
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-run-resume-")))
    scratch.push(directory)
    Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
    const prompts: string[] = []
    const failing = new Set(options.failing ? [options.failing] : [])
    // What each task saw on disk when it started: the half-done work of a failed attempt must be gone.
    const seen: Record<string, string[]> = {}
    const name = (text: string) => steps.find((step) => text.endsWith(prompt(step)))!
    const sessions = new Map<string, string>()
    const engine = {
      createSession: async () => ({ id: `ses_${sessions.size + prompts.length}_${crypto.randomUUID().slice(0, 6)}` }),
      prompt: async (input: { sessionID: string; text: string }) => {
        const step = name(input.text)
        prompts.push(step)
        sessions.set(input.sessionID, step)
        seen[step] = steps.filter((other) => existsSync(join(directory, `${other}.txt`)))
        writeFileSync(join(directory, `${step}.txt`), `${step} attempt ${prompts.filter((entry) => entry === step).length}`)
      },
      waitForIdle: async (sessionID: string) => {
        if (sessions.get(sessionID) === options.hanging) await new Promise(() => undefined)
      },
      lastAnswer: async (sessionID: string) => {
        const step = sessions.get(sessionID)!
        if (failing.delete(step)) return { text: "", error: `${step} broke`, tokens: 5, cost: 0.5 }
        return { text: `${step} done`, tokens: 10, cost: 0.01 }
      },
      interrupt: async () => undefined,
    }
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    Object.assign(scheduler, { engine })
    const start = () => scheduler.runTasks({ directory, tasks: steps.map((step) => ({ name: step, prompt: prompt(step) })) })
    return { repository, directory, scheduler, engine, prompts, seen, start }
  }

  const statuses = (repository: SqliteRoutineRepository, runID: string) =>
    repository.listTasks(runID).map((task) => `${task.name}:${task.status}${task.attempt > 1 ? `#${task.attempt}` : ""}`)

  test("a 4-task run that failed at task 3 runs tasks 3 and 4 only, and keeps what 1 and 2 did", async () => {
    const { repository, directory, scheduler, prompts, seen, start } = stack({ failing: "three" })
    const run = await start()
    await settledAt(repository, run.id, "failed")
    expect(statuses(repository, run.id)).toEqual(["one:success", "two:success", "three:failed", "four:queued"])
    const before = repository.listTasks(run.id)
    // Every task's session spent something on the ledger, attributed to it (UL-04).
    repository.recordUsage({
      events: before.flatMap((task) =>
        task.sessionID
          ? [
              {
                id: `${task.sessionID}:step`,
                kind: "step" as const,
                sessionID: task.sessionID,
                providerID: "anthropic",
                modelID: "sonnet",
                tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                costUSD: 0.01,
                costBasis: "engine-list-price" as const,
                billing: "metered" as const,
                startedAt: 1000,
                endedAt: 2000,
              },
            ]
          : [],
      ),
      tools: [],
    })
    const points = repository.listCheckpoints({ runID: run.id })
    expect(points.map((point) => point.title)).toEqual(["two", "one"])
    prompts.length = 0

    const plan = await scheduler.resumePlan(run.id)
    expect(plan?.tasks.map((task) => task.name)).toEqual(["three", "four"])
    expect(plan?.checkpoint?.title).toBe("two")
    // The failed attempt's file is not in the point the folder goes back to.
    expect(plan?.plan).toEqual({ write: [], remove: ["three.txt"] })

    await scheduler.resume(run.id)
    await settledAt(repository, run.id, "success")

    expect(prompts).toEqual(["three", "four"])
    expect(seen.three).toEqual(["one", "two"])
    expect(statuses(repository, run.id)).toEqual([
      "one:success",
      "two:success",
      "three:failed",
      "four:success",
      "three:success#2",
    ])
    // Succeeded tasks are the same rows, with the same output, cost and session.
    const after = repository.listTasks(run.id)
    for (const task of before.slice(0, 2)) expect(after.find((entry) => entry.id === task.id)).toEqual(task)
    // The failed attempt keeps what it said and cost; the new one is an attempt of its own.
    expect(after[2]).toMatchObject({ status: "failed", error: "three broke", cost: 0.5 })
    expect(after[4]).toMatchObject({ retryOf: after[2]!.id, attempt: 2, output: "three done" })
    // Their checkpoints stay, and the resumed tasks add their own.
    expect(repository.listCheckpoints({ runID: run.id }).map((point) => point.title)).toEqual([
      "four",
      "three",
      "two",
      "one",
    ])
    // Where the folder was before the restore is a checkpoint like any restore's (it was dropped).
    expect(repository.listCheckpoints({ directory }).filter((point) => !point.runID).map((point) => point.title)).toEqual([
      'Before resuming from "two"',
    ])
    // The ledger rows of the tasks that ran before stay theirs.
    const report = (
      await handleUsageRead(
        new Request(`http://127.0.0.1/harness/usage/runs/${run.id}`),
        ["harness", "usage", "runs", run.id],
        repository,
      )!.json()
    ).data
    for (const task of before.filter((entry) => entry.sessionID))
      expect(report.byTask.find((group: { key: string }) => group.key === task.id)?.events).toBe(1)
    // RP-06: the run's verdict is read from the newest attempt, not from the failure it replaced.
    expect(repository.getRun(run.id)?.verdict?.value).not.toBe("failed")
    repository.close()
  })

  for (const [index, failing] of steps.entries()) {
    test(`resuming from task ${index + 1} runs it and what follows, from the folder as it was before it`, async () => {
      const { repository, scheduler, prompts, seen, start } = stack({ failing })
      const run = await start()
      await settledAt(repository, run.id, "failed")
      const broken = repository.listTasks(run.id).find((task) => task.name === failing)!
      prompts.length = 0

      const plan = await scheduler.resumePlan(run.id, broken.id)
      // Before the first task nothing was recorded, so there is nothing to go back to.
      expect(plan?.checkpoint?.title).toBe(index === 0 ? undefined : steps[index - 1])
      await scheduler.resume(run.id, { fromTask: broken.id })
      await settledAt(repository, run.id, "success")

      expect(prompts).toEqual(steps.slice(index))
      if (index > 0) expect(seen[failing]).toEqual(steps.slice(0, index))
      expect(repository.listTasks(run.id).filter((task) => task.status === "success").map((task) => task.name).sort()).toEqual(
        [...steps].sort(),
      )
      repository.close()
    })
  }

  test("after a restart, the task that was in flight runs again from the folder before it, and the rest follows", async () => {
    const first = stack({ hanging: "three" })
    const run = await first.start()
    const deadline = Date.now() + 10_000
    while (!first.repository.listTasks(run.id).some((task) => task.name === "three" && task.status === "running"))
      if (Date.now() < deadline) await Bun.sleep(10)
      else throw new Error("three never started")
    // The process dies here. A new one starts on the same database.
    first.repository.recoverRunning(Date.now())
    expect(statuses(first.repository, run.id)).toEqual(["one:success", "two:success", "three:queued", "four:queued"])
    const scheduler = new RoutineScheduler({ repository: first.repository, engineURL: "http://127.0.0.1:1" })
    const prompts: string[] = []
    Object.assign(scheduler, {
      engine: {
        ...first.engine,
        prompt: async (input: { sessionID: string; text: string }) => {
          prompts.push(input.text)
          await first.engine.prompt(input)
        },
        waitForIdle: async () => undefined,
      },
    })

    expect((await scheduler.resumePlan(run.id))?.checkpoint?.title).toBe("two")
    await scheduler.resume(run.id)
    await settledAt(first.repository, run.id, "success")

    expect(prompts.map((text) => text.split(" ").at(-1))).toEqual(["three", "four"])
    expect(first.seen.three).toEqual(["one", "two"])
    expect(statuses(first.repository, run.id)).toEqual(["one:success", "two:success", "three:success", "four:success"])
    first.repository.close()
  })

  test("a stopped run resumes the task it stopped in as a new attempt, and the ones it never reached as themselves", async () => {
    const { repository, scheduler, prompts, start } = stack({ hanging: "three" })
    const run = await start()
    while (!repository.listTasks(run.id).some((task) => task.name === "three" && task.status === "running")) await Bun.sleep(10)
    // The hanging turn is never interrupted by this engine, so the run is let go as a restart would.
    repository.finishTask(repository.listTasks(run.id)[2]!.id, "stopped", { error: "The run was stopped" })
    repository.finishTask(repository.listTasks(run.id)[3]!.id, "stopped", { error: "The run was stopped" })
    repository.finishRun(run.id, "stopped")
    prompts.length = 0
    Object.assign(scheduler, { engine: { ...(scheduler as unknown as { engine: object }).engine, waitForIdle: async () => undefined } })

    await scheduler.resume(run.id)
    await settledAt(repository, run.id, "success")

    expect(prompts).toEqual(["three", "four"])
    expect(statuses(repository, run.id)).toEqual(["one:success", "two:success", "three:stopped", "four:success", "three:success#2"])
    // Requeued as itself, it lost what the stop wrote on it.
    expect(repository.listTasks(run.id)[3]).toMatchObject({ attempt: 1, output: "four done" })
    repository.close()
  })

  test("a resumed task clears the verdict it was given, so the run reads the new one (RP-06)", async () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    const [work, gated] = repository.addTasks(run.id, [
      { name: "work", prompt: "x" },
      { name: "after", prompt: "y", require: "verified" },
    ])
    repository.startTask(work!.id, 1100)
    repository.finishTask(work!.id, "failed", { error: "no" }, 1200)
    repository.setTaskVerdict(work!.id, { value: "failed", reason: "no", source: "rule" })
    repository.finishTask(gated!.id, "skipped", { error: "Not run: work was not verified" }, 1300)
    repository.setTaskVerdict(gated!.id, { value: "failed", reason: "stale", source: "rule" })
    repository.finishRun(run.id, "failed", "no", 1400)
    expect(repository.getRun(run.id)?.verdict?.value).toBe("failed")

    const point = resumePoint(repository.getRun(run.id)!, repository.listTasks(run.id), [])
    expect(point.again.map((task) => task.name)).toEqual(["work", "after"])
    repository.requeueTasks([gated!.id])
    repository.addTasks(run.id, [{ name: "work", prompt: "x", attempt: 2, retryOf: work!.id }])

    expect(repository.getTask(gated!.id)).toMatchObject({ status: "queued" })
    expect(repository.getTask(gated!.id)?.verdict).toBeUndefined()
    expect(repository.getTask(gated!.id)?.error).toBeUndefined()
    expect(repository.getRun(run.id)?.verdict).toBeUndefined()
    repository.close()
  })

  test("only a task that did not succeed, and the newest attempt of it, can be resumed from", () => {
    const repository = open()
    const run = repository.startRun(manual, 1000)
    const [done, failed] = repository.addTasks(run.id, [
      { name: "done", prompt: "x" },
      { name: "failed", prompt: "y" },
    ])
    const [retried] = repository.addTasks(run.id, [{ name: "failed", prompt: "y", attempt: 2, retryOf: failed!.id }])
    repository.finishTask(done!.id, "success", {}, 1100)
    repository.finishTask(failed!.id, "failed", {}, 1200)
    repository.finishTask(retried!.id, "failed", {}, 1300)
    const tasks = repository.listTasks(run.id)
    const resumeFrom = (id: string) => () => resumePoint(run, tasks, [], id)

    expect(resumeFrom(done!.id)).toThrow(/failed, was stopped or was skipped/)
    expect(resumeFrom(failed!.id)).toThrow(/newer attempt/)
    expect(resumeFrom("nope")).toThrow(/not part of the run/)
    expect(resumePoint(run, tasks, [], retried!.id).again.map((task) => task.id)).toEqual([retried!.id])
    repository.close()
  })
})
