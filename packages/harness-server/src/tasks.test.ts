import { describe, expect, test } from "bun:test"
import { SqliteRoutineRepository } from "./repository"
import type { RunSource } from "./types"

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
