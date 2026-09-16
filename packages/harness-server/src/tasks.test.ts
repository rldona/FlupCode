import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import type { RunSource } from "./types"

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
