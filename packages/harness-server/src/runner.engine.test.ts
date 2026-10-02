import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { approvalOptions } from "./action-approval"
import { createHarnessHandler } from "./api"
import { CONFINED, Engine, NO_SHELL } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { RoutineScheduler } from "./scheduler"
import type { RunSource } from "./types"

/**
 * The task runner against the pinned OpenCode 2 engine (V2-26): two tasks in order, a run stopped
 * mid-turn, a failed check retried until it passes, and a task in a worktree of its own. It starts an
 * engine, so it only runs when asked, as CI's engine job does:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/runner.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
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

describe.skipIf(!run)("the task runner on an OpenCode 2 engine", () => {
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
    const messages = await engine.messages(tasks[1]!.sessionID!)
    const prompt = messages.find((message) => message.info?.role === "user")
    expect(JSON.stringify(prompt)).toContain("Decided: notes")
  })

  // TI-03: a run that stops at a gate is driven again by a new runner after approval, and the task
  // behind the gate still starts from the gated task's closing note.
  test("after a gate, the next task is handed the gated task's closing note", async () => {
    const repository = open()
    model.push(
      { type: "text", text: "Plan: rename the parser" },
      { type: "text", text: "Decided: rename the parser" },
      { type: "text", text: "Renamed it" },
      { type: "text", text: "Decided: renamed" },
    )
    const run = repository.startRun(manual, Date.now(), contract.project)
    repository.addTasks(run.id, [
      { name: "plan", prompt: "Plan it", gate: "human" },
      { name: "implement", prompt: "Implement it", dependsOn: ["plan"] },
    ])
    expect(await new TaskRunner(repository, engine).execute(run, { directory: contract.project })).toBe("paused")
    repository.resumeRun(run.id)
    expect(
      await new TaskRunner(repository, engine).execute(repository.getRun(run.id)!, { directory: contract.project }),
    ).toBe("done")

    const implement = repository.listTasks(run.id).find((task) => task.name === "implement")!
    expect(implement.status).toBe("success")
    const prompt = (await engine.messages(implement.sessionID!)).find((message) => message.info?.role === "user")
    expect(JSON.stringify(prompt)).toContain("Decided: rename the parser")
  })

  // TI-02: idle is not success. A provider that refuses the call (here a 401, as for a bad key)
  // leaves an errored step, and the task must fail with what the provider said.
  test("a task whose model call is refused fails with the provider's message", async () => {
    const repository = open()
    model.push({ type: "error", status: 401, message: "Invalid API key provided" })
    const run = repository.startRun(manual, Date.now(), contract.project)
    repository.addTasks(run.id, [{ name: "refused", prompt: "Do it" }])
    await expect(new TaskRunner(repository, engine).execute(run, { directory: contract.project })).rejects.toThrow(
      "Invalid API key provided",
    )

    const task = repository.listTasks(run.id)[0]!
    expect(task.status).toBe("failed")
    expect(task.error).toContain("Invalid API key provided")
    // What the failed turn cost is kept, even when it is nothing.
    expect(task.cost).toBe(0)
  })

  // RP-06: a turn that ends cleanly is not a goal met. An agent that gives up still leaves an idle
  // session and a successful step, so the verdict comes from something other than the agent.
  test("a task whose agent gives up carries a failed verdict with the agent's own reason", async () => {
    const repository = open()
    model.push({ type: "text", text: "I looked at the parser.\n\nI cannot do this without the vendor's API key, so I stop here." })
    const run = repository.startRun(manual, Date.now(), contract.project)
    repository.addTasks(run.id, [{ name: "gave-up", prompt: "Fix the parser" }])
    expect(await new TaskRunner(repository, engine).execute(run, { directory: contract.project })).toBe("done")

    const task = repository.listTasks(run.id)[0]!
    expect(task.status).toBe("success")
    expect(task.verdict).toEqual({
      value: "failed",
      reason: "I cannot do this without the vendor's API key, so I stop here.",
      source: "rule",
    })
    expect(repository.getRun(run.id)?.verdict).toMatchObject({ value: "failed", taskID: task.id })
    expect(repository.listArtifacts({ runID: run.id, kind: "verdict" }).map((artifact) => artifact.title)).toEqual([
      "gave-up — failed",
    ])
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
    await until(async () => (await engine.isBusy(session)) || undefined)
    stop = true
    await engine.interrupt(session)
    await execution
    expect(repository.listTasks(run.id)[0]?.status).toBe("stopped")
    await until(async () => !(await engine.isBusy(session)) || undefined)
  })

  // TI-01: the scheduler's Stop, not a test calling `engine.interrupt` itself. A run of one task has
  // no thread of its own, and a run of two has an idle one; either way it is the task's session that
  // is working, and "stopped" has to mean the engine stopped it.
  for (const shape of ["one task", "two tasks"] as const) {
    test(`stopping a run of ${shape} stops the engine working on the live task`, async () => {
      const repository = open()
      const scheduler = new RoutineScheduler({
        repository,
        engineURL: contract.url,
        authorization: contract.authorization,
      })
      model.push({ type: "hang" })
      const tasks =
        shape === "one task"
          ? [{ name: "long", prompt: "Take your time" }]
          : [
              { name: "long", prompt: "Take your time" },
              { name: "after", prompt: "Then this", dependsOn: ["long"] },
            ]
      const run = await scheduler.runTasks({ tasks, directory: contract.project })
      const session = await until(() => repository.listTasks(run.id)[0]?.sessionID)
      await until(async () => (await engine.isBusy(session)) || undefined)
      const asked = model.requests.length

      await scheduler.stopRun(run.id)
      // The task reads "stopped" only once the engine has let go of its session, and within 5 s.
      await until(() => repository.listTasks(run.id)[0]?.status === "stopped" || undefined, 5_000)
      expect(await engine.isBusy(session)).toBe(false)
      await until(() => repository.getRun(run.id)?.status === "stopped" || undefined, 5_000)
      expect(repository.listTasks(run.id).map((task) => task.status)).toEqual(tasks.map(() => "stopped"))
      await Bun.sleep(500)
      // Nothing more is asked of the model: not the task, and not a closing note for a next task.
      expect(model.requests.length).toBe(asked)
    }, 20_000)
  }

  test("deleting a routine mid-run stops the engine working on its run", async () => {
    const repository = open()
    const scheduler = new RoutineScheduler({
      repository,
      engineURL: contract.url,
      authorization: contract.authorization,
    })
    const handler = createHarnessHandler(repository, scheduler)
    model.push({ type: "hang" })
    const routine = repository.create({
      name: "long",
      description: "",
      prompt: "Take your time",
      schedule: { type: "manual" },
      projectDirectory: contract.project,
    })
    const run = await scheduler.runNow(routine.id)
    const session = await until(() => repository.listTasks(run.id)[0]?.sessionID)
    await until(async () => (await engine.isBusy(session)) || undefined)

    const removed = await handler(new Request(`http://localhost/harness/routines/${routine.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)
    await until(async () => !(await engine.isBusy(session)) || undefined, 5_000)
  }, 20_000)

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
    // the shell.
    model.push(
      { type: "text", text: "I looked at it" },
      { type: "text", text: "Decided: nothing yet" },
      { type: "tool", name: "shell", input: { command: `rm ${join(directory, "broken")}`, description: "Fix it" } },
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
    // RP-06: the check that passed is what verifies the work, and the superseded attempt no longer
    // speaks for the run.
    expect(repository.listTasks(run.id).map((task) => task.verdict?.value)).toEqual([
      "failed",
      "failed",
      "verified",
      "verified",
    ])
    expect(repository.getRun(run.id)?.verdict).toMatchObject({ value: "verified", source: "check" })
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

test.skipIf(!run)("a confined session's rules reach 2.x in its own names", async () => {
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

test.skipIf(!run)(
  "a web action's approval is asked in the session and answered there",
  async () => {
    const session = await engine.createSession({ directory: contract.project, title: "approval" })
    const asked = engine.askChoice({
      sessionID: session.id,
      title: "Allow the agent to read pages on example.com?",
      description: "Search the catalogue",
      options: approvalOptions("read", "example.com"),
      metadata: { flupcode: "browser-approval", origin: "https://example.com", site: "example.com", tier: "read", action: "search" },
      timeoutMs: 20_000,
    })
    const headers = { authorization: contract.authorization, "content-type": "application/json" }
    // What the app sees: a pending form with the answers and the site it is for (BU-01), which it
    // shows as a browser approval and answers like a question.
    const form = await until(async () => {
      const list = (await (await fetch(`${contract.url}/api/session/${session.id}/form`, { headers })).json()) as {
        data: Array<{ id: string; metadata?: Record<string, unknown>; fields: Array<{ options?: Array<{ value: string }> }> }>
      }
      return list.data[0]
    })
    expect(form.fields[0]!.options!.map((option) => option.value)).toEqual(["once", "session", "always", "deny"])
    expect(form.metadata).toMatchObject({ flupcode: "browser-approval", site: "example.com", tier: "read" })
    await fetch(`${contract.url}/api/session/${session.id}/form/${form.id}/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ answer: { choice: "always" } }),
    })
    expect(await asked).toBe("always")
  },
)

async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
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
