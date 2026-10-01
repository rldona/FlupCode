import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { APPROVAL_OPTIONS } from "./action-approval"
import { CONFINED, Engine, NO_SHELL } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import type { RunSource } from "./types"

/**
 * The task runner against a real engine (V2-26), on either line: `v1` drives the vendored 1.x engine,
 * `v2` the pinned 2.x one. The same four runs must come out the same on both: two tasks in order, a
 * run stopped mid-turn, a failed check retried until it passes, and a task in a worktree of its own.
 * It starts an engine, so it only runs when a line is named, as CI's engine job does:
 *
 *   FLUPCODE_CONTRACT_LINE=v1 bun test src/runner.engine.test.ts
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/runner.engine.test.ts
 */
const run = !!process.env.FLUPCODE_CONTRACT_LINE
const model = startModel()
const manual: RunSource = { type: "manual" }
const repositories: SqliteRoutineRepository[] = []
let contract: ContractEngine
let engine: Engine

beforeAll(async () => {
  if (!run) return
  contract = await startEngine({ modelUrl: model.url })
  engine = new Engine(contract.url, contract.authorization)
}, 120_000)

beforeEach(() => model.reset())

afterAll(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  await contract?.stop()
  model.stop()
})

const open = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return repository
}

describe.skipIf(!run)(`the task runner on a ${CONTRACT_LINE} engine`, () => {
  test("two tasks run in order, the second handed the first's closing note", async () => {
    const repository = open()
    // The first task, its closing note (a session of its own), the second task, its note.
    model.push(
      { type: "text", text: "Plan: write the notes" },
      { type: "text", text: "Decided: notes" },
      { type: "text", text: "Built the notes" },
      { type: "text", text: "Decided: built" },
    )
    const run = repository.startRun(manual, Date.now(), contract.project)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it" },
      { name: "build", prompt: "Build it", dependsOn: ["plan"] },
    ])
    expect(await new TaskRunner(repository, engine).execute(run, { directory: contract.project })).toBe("done")

    const tasks = repository.listTasks(run.id)
    expect(tasks.map((task) => [task.name, task.status, task.output])).toEqual([
      ["plan", "success", "Plan: write the notes"],
      ["build", "success", "Built the notes"],
    ])
    expect(tasks.every((task) => typeof task.sessionID === "string" && (task.tokens ?? 0) > 0)).toBe(true)
    // The second task's prompt carried the first one's note, which the engine recorded as its message.
    const messages = await engine.messages(tasks[1]!.sessionID!, contract.project)
    const prompt = messages.find((message) => message.info?.role === "user")
    expect(JSON.stringify(prompt)).toContain("Decided: notes")
  })

  test("a run stopped mid-turn finishes stopped, and the engine stops working on it", async () => {
    const repository = open()
    model.push({ type: "hang" })
    const run = repository.startRun(manual, Date.now(), contract.project)
    repository.addTasks(run.id, [{ name: "long", prompt: "Take your time" }])
    let stop = false
    const execution = new TaskRunner(repository, engine).execute(run, {
      directory: contract.project,
      stopped: () => stop,
    })
    const session = await until(() => repository.listTasks(run.id)[0]?.sessionID)
    await until(async () => (await engine.isBusy(session, contract.project)) || undefined)
    stop = true
    await engine.interrupt(session, contract.project)
    await execution
    expect(repository.listTasks(run.id)[0]?.status).toBe("stopped")
    await until(async () => !(await engine.isBusy(session, contract.project)) || undefined)
  })

  test("a failed check is retried with its evidence, and the second attempt fixes it", async () => {
    const repository = open()
    const directory = join(contract.project, "retry")
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, "broken"), "yes")
    writeFileSync(
      join(directory, ".flupcode", "project.yaml"),
      "verify:\n  test: test ! -f broken || { echo 'still broken' >&2; exit 1; }\n",
    )
    // The first attempt only talks (and its closing note is a session of its own); the second runs
    // the shell, which is `bash` on 1.x and `shell` on 2.x.
    const shell = CONTRACT_LINE === "v2" ? "shell" : "bash"
    model.push(
      { type: "text", text: "I looked at it" },
      { type: "text", text: "Decided: nothing yet" },
      { type: "tool", name: shell, input: { command: `rm ${join(directory, "broken")}`, description: "Fix it" } },
      { type: "text", text: "Removed it" },
    )
    const run = repository.startRun(manual, Date.now(), directory)
    repository.addTasks(run.id, [
      { name: "build", prompt: "Make it work" },
      { name: "verify", prompt: "", kind: "verify", retries: 2 },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory })

    expect(repository.listTasks(run.id).map((task) => `${task.name}#${task.attempt}:${task.status}`)).toEqual([
      "build#1:success",
      "verify#1:failed",
      "build#2:success",
      "verify#2:success",
    ])
    expect(existsSync(join(directory, "broken"))).toBe(false)
  })

  test("a run with worktrees gives its task a tree of its own", async () => {
    const repository = open()
    const directory = join(contract.project, "repo")
    mkdirSync(directory, { recursive: true })
    await git(directory, "init", "-q")
    writeFileSync(join(directory, "README.md"), "contract\n")
    await git(directory, "add", ".")
    await git(directory, "-c", "user.email=contract@example.com", "-c", "user.name=Contract", "commit", "-qm", "init")
    model.push({ type: "text", text: "Worked in my tree" })
    const run = repository.startRun(manual, Date.now(), directory, { worktrees: true })
    repository.addTasks(run.id, [{ name: "tree", prompt: "Work here" }])
    await new TaskRunner(repository, engine).execute(run, { directory })

    const task = repository.listTasks(run.id)[0]!
    expect(task.status).toBe("success")
    expect(task.directory).toBeDefined()
    expect(task.directory).not.toBe(directory)
    expect(existsSync(join(task.directory!, "README.md"))).toBe(true)
    await engine.removeWorktree({ directory: task.directory!, project: directory })
    expect(existsSync(task.directory!)).toBe(false)
  })
})

test.skipIf(!run || CONTRACT_LINE !== "v2")("a confined session's rules reach 2.x in its own names", async () => {
  const session = await engine.createSession({
    directory: contract.project,
    title: "confined",
    permission: [...CONFINED, ...NO_SHELL],
  })
  const read = await fetch(`${contract.url}/api/session/${session.id}`, {
    headers: { authorization: contract.authorization },
  })
  expect(((await read.json()) as { data: { permissions?: unknown[] } }).data.permissions).toEqual([
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ])
})

test.skipIf(!run || CONTRACT_LINE !== "v2")(
  "a web action's approval is asked in the session and answered there",
  async () => {
    const session = await engine.createSession({ directory: contract.project, title: "approval" })
    const asked = engine.askChoice({
      sessionID: session.id,
      title: "Allow web actions on https://example.com?",
      description: "Search the catalogue",
      options: APPROVAL_OPTIONS,
      timeoutMs: 20_000,
    })
    const headers = { authorization: contract.authorization, "content-type": "application/json" }
    // What the app sees: a pending form with the three answers, which it answers like a question.
    const form = await until(async () => {
      const list = (await (await fetch(`${contract.url}/api/session/${session.id}/form`, { headers })).json()) as {
        data: Array<{ id: string; fields: Array<{ options?: Array<{ value: string }> }> }>
      }
      return list.data[0]
    })
    expect(form.fields[0]!.options!.map((option) => option.value)).toEqual(["once", "always", "deny"])
    await fetch(`${contract.url}/api/session/${session.id}/form/${form.id}/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ answer: { choice: "always" } }),
    })
    expect(await asked).toBe("always")
  },
)

async function until<T>(read: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(50)
  }
}

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" })
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
}
