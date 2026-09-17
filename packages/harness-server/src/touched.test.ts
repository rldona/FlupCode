import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { take } from "./checkpoint"
import { changedBetween, filesPerTask } from "./touched"
import { detailOf, isRunningTool, toolNameOf, toolStartOf } from "./engine"

let directory = ""

const run = async (args: string[]) => {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  await child.exited
  return (await new Response(child.stdout).text()).trim()
}
const write = (name: string, body: string) => writeFileSync(join(directory, name), body)

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-touched-"))
  await run(["init", "-q", "-b", "main"])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Test"])
  write("start.txt", "one\n")
  await run(["add", "-A"])
  await run(["commit", "-qm", "first"])
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe("filesPerTask", () => {
  test("gives each task exactly what it changed, and nothing the task before it did", async () => {
    write("plan.md", "a plan\n")
    const first = await take({ directory, title: "plan", taskID: "task_1" })

    write("app.ts", "the work\n")
    write("start.txt", "two\n")
    const second = await take({ directory, title: "write", taskID: "task_2" })

    const perTask = await filesPerTask(directory, [first, second])

    expect(perTask[0]).toMatchObject({ taskID: "task_1", title: "plan" })
    expect(perTask[0]!.files).toEqual([{ path: "plan.md", status: "added" }])
    // The second task's list does not repeat the first's work, which is the whole point.
    expect(perTask[1]!.files).toEqual([
      { path: "app.ts", status: "added" },
      { path: "start.txt", status: "modified" },
    ])
  })

  test("the first task is compared against where the folder was when the run began", async () => {
    write("made.txt", "by the first task\n")
    const only = await take({ directory, title: "write", taskID: "task_1" })

    const perTask = await filesPerTask(directory, [only])

    expect(perTask[0]!.files).toEqual([{ path: "made.txt", status: "added" }])
  })

  test("catches a file written by a shell command, which no tool listing would report", async () => {
    // This is why it is worked out from the folder and not from the agent's tool calls.
    await Bun.spawn(["sh", "-c", "echo generated > built.js"], { cwd: directory }).exited
    const checkpoint = await take({ directory, title: "build", taskID: "task_1" })

    expect((await filesPerTask(directory, [checkpoint]))[0]!.files).toEqual([
      { path: "built.js", status: "added" },
    ])
  })

  test("a task that changed nothing says so, rather than being left out", async () => {
    const first = await take({ directory, title: "plan", taskID: "task_1" })
    const second = await take({ directory, title: "verify", taskID: "task_2" })

    const perTask = await filesPerTask(directory, [first, second])

    expect(perTask).toHaveLength(2)
    expect(perTask[1]!.files).toEqual([])
  })

  test("reports a deletion as a deletion", async () => {
    const first = await take({ directory, title: "before", taskID: "task_1" })
    rmSync(join(directory, "start.txt"))
    const second = await take({ directory, title: "tidy", taskID: "task_2" })

    expect((await filesPerTask(directory, [first, second]))[1]!.files).toEqual([
      { path: "start.txt", status: "deleted" },
    ])
  })

  test("nothing recorded, nothing claimed", async () => {
    expect(await filesPerTask(directory, [])).toEqual([])
  })
})

test("changedBetween answers empty for a commit that is not there", async () => {
  // A repository can be cleaned by hand; that is not a reason to throw at a reader looking at a run.
  expect(await changedBetween(directory, "0".repeat(40), "1".repeat(40))).toEqual([])
})

describe("detailOf", () => {
  test("picks the argument that says what the tool is working on", () => {
    expect(detailOf({ pattern: "project.yaml", path: "/repo" })).toBe("project.yaml")
    expect(detailOf({ command: "bun test" })).toBe("bun test")
    expect(detailOf({ filePath: "src/app.ts" })).toBe("src/app.ts")
  })

  test("is a label, so it does not carry a whole file in it", () => {
    // A `write` call's input holds the file's entire contents.
    expect(detailOf({ filePath: "a.ts", content: "x".repeat(10_000) })!.length).toBeLessThanOrEqual(160)
    expect(detailOf({ content: "y".repeat(500) })).toBeUndefined()
  })

  test("nothing worth saying is nothing", () => {
    expect(detailOf(undefined)).toBeUndefined()
    expect(detailOf({})).toBeUndefined()
    expect(detailOf({ command: "   " })).toBeUndefined()
  })
})

describe("reading a running tool call", () => {
  // The two shapes the engine reports one in. Coding against the SDK types alone reads `undefined`
  // for the name and the time against a real engine, which is exactly what happened.
  const legacy = {
    type: "tool",
    tool: "bash",
    state: { status: "running", input: { command: "sleep 25" }, time: { start: 1_000 } },
  }
  const v2 = {
    type: "tool",
    name: "glob",
    state: { status: "running", input: { pattern: "project.yaml" } },
    time: { created: 900, ran: 1_000 },
  }

  test("names the tool whichever field it arrived in", () => {
    expect(toolNameOf(legacy)).toBe("bash")
    expect(toolNameOf(v2)).toBe("glob")
  })

  test("times it whichever field it arrived in", () => {
    expect(toolStartOf(legacy)).toBe(1_000)
    expect(toolStartOf(v2)).toBe(1_000)
  })

  test("a call that has finished is not running, in either shape", () => {
    expect(isRunningTool({ ...legacy, state: { ...legacy.state, time: { start: 1_000, end: 2_000 } } })).toBe(false)
    expect(isRunningTool({ ...v2, time: { created: 900, ran: 1_000, completed: 2_000 } })).toBe(false)
  })

  test("running is running", () => {
    expect(isRunningTool(legacy)).toBe(true)
    expect(isRunningTool(v2)).toBe(true)
  })

  test("what is not a tool call is not one", () => {
    expect(isRunningTool({ type: "text", text: "hello" })).toBe(false)
    expect(isRunningTool({ type: "tool", state: { status: "completed" } })).toBe(false)
    expect(isRunningTool(undefined)).toBe(false)
  })
})
