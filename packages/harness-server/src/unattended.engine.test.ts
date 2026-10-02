import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { CONTRACT_LINE, startEngine, type Engine as EngineProcess } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { Engine } from "./engine"
import { planExit } from "./plan-exit"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { RoutineScheduler } from "./scheduler"
import type { RunSource } from "./types"

/**
 * A task that needs a person, on the pinned engine (RP-05), with FlupCode's plugins and
 * harness-server's real plan hand-off. The engine is configured to ask before every edit, as a user's
 * `permission: { edit: ask }` makes it, and the plan agent hands off through `plan_exit`, which asks
 * in the session. Before RP-05 both left the task waiting for the thirty-minute cap. Proved here:
 * `deny` fails the task within seconds naming what it needed and leaves nothing waiting in the
 * engine; `gate` holds the run as `awaiting` until the engine's request is answered, and the answer
 * lets the same turn carry on. And the agents plugin's floor, which now fails closed: an agent whose
 * rules it can read is let through, and one whose rules vanish mid-turn never gets a denied call
 * through. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/unattended.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const manual: RunSource = { type: "manual" }
let engine: EngineProcess
let adapter: Engine
let client: ReturnType<typeof OpenCode.make>
let server: ReturnType<typeof Bun.serve>
let repository: SqliteRoutineRepository

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  let serve: ((request: Request) => Response | Promise<Response>) | undefined
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => serve!(request) })
  engine = await startEngine({
    modelUrl: model.url,
    // A user who asked to approve every edit.
    config: { permission: { edit: "ask" } },
    env: {
      OPENCODE_PURE: undefined,
      // A project's own agents load, for the floor below.
      OPENCODE_DISABLE_PROJECT_CONFIG: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${server.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    flupcodePlugins: true,
    prepare: async (home) => {
      // The memory plugin's extraction asks the model after a turn, which would take a scripted reply.
      writeFileSync(join(home, "..", "project", "opencode.json"), JSON.stringify({ memory: { auto: false } }))
    },
  })
  adapter = new Engine(engine.url, engine.authorization)
  client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: engine.authorization } })
  serve = createHarnessHandler(
    repository,
    new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization }),
    { token: "ui-token", pluginToken: "plugin-token", planExit: (sessionID) => planExit(adapter, sessionID) },
  )
}, 180_000)

beforeEach(() => {
  model.reset()
  if (run) writeFileSync(join(engine.project, "notes.txt"), "untouched\n")
})

afterAll(async () => {
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  model.stop()
})

const editNotes = () => ({
  type: "tool" as const,
  name: "edit",
  input: { path: join(engine.project, "notes.txt"), oldString: "untouched", newString: "edited" },
})

const pending = async () => ({
  permissions: (await client.permission.request.list({ location: { directory: engine.project } })).data,
  forms: (await client.form.list({ location: { directory: engine.project } })).data,
})

async function until(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(50)
  expect(check()).toBe(true)
}

describe.skipIf(!run)("a task that needs a person, on OpenCode 2", () => {
  test("deny: a task that needs approval to edit fails within seconds, naming the tool", async () => {
    model.push(editNotes(), { type: "text", text: "Edited" })
    const started = Date.now()
    const job = repository.startRun(manual, Date.now(), engine.project, { policy: { unattended: "deny" } })
    repository.addTasks(job.id, [{ name: "edit", prompt: "Edit the notes" }])
    await expect(new TaskRunner(repository, adapter).execute(job, { directory: engine.project })).rejects.toThrow(
      "Needed approval to use `edit`",
    )

    expect(Date.now() - started).toBeLessThan(15_000)
    const task = repository.listTasks(job.id)[0]!
    expect(task.status).toBe("failed")
    expect(task.error).toBe("Needed approval to use `edit` on notes.txt, and this run fails a task that needs a person")
    expect(task.verdict).toMatchObject({ value: "needs-user", reason: task.error })
    expect(readFileSync(join(engine.project, "notes.txt"), "utf8")).toBe("untouched\n")
    // Nothing is left asking in the engine, and the turn is over.
    expect((await pending()).permissions.filter((request) => request.sessionID === task.sessionID)).toEqual([])
    expect(await adapter.isBusy(task.sessionID!)).toBe(false)
  }, 60_000)

  test("deny: the plan agent's hand-off form fails the task with the question it asked", async () => {
    model.push({ type: "tool", name: "plan_exit", input: {} }, { type: "text", text: "Planned" })
    const job = repository.startRun(manual, Date.now(), engine.project, { policy: { unattended: "deny" } })
    repository.addTasks(job.id, [{ name: "plan", prompt: "Plan it", agent: "plan" }])
    await expect(new TaskRunner(repository, adapter).execute(job, { directory: engine.project })).rejects.toThrow(
      'Asked "The plan is complete.',
    )

    const task = repository.listTasks(job.id)[0]!
    expect(task.verdict?.value).toBe("needs-user")
    expect((await pending()).forms.filter((form) => form.sessionID === task.sessionID)).toEqual([])
  }, 60_000)

  test("gate: the run awaits while the edit waits for approval, and answering it in the engine carries on", async () => {
    model.push(editNotes(), { type: "text", text: "Edited" })
    const job = repository.startRun(manual, Date.now(), engine.project)
    repository.addTasks(job.id, [{ name: "edit", prompt: "Edit the notes" }])
    const going = new TaskRunner(repository, adapter).execute(job, { directory: engine.project })

    await until(() => repository.getRun(job.id)?.status === "awaiting")
    expect(repository.getRun(job.id)?.paused).toBe("request")
    const task = repository.listTasks(job.id)[0]!
    expect(task.status).toBe("running")
    const [request] = (await pending()).permissions.filter((entry) => entry.sessionID === task.sessionID)
    expect(request).toMatchObject({ action: "edit", resources: ["notes.txt"] })

    await client.permission.reply({ sessionID: task.sessionID!, requestID: request!.id, decision: "once" })
    expect(await going).toBe("done")
    expect(repository.getRun(job.id)?.status).toBe("running")
    expect(repository.getRun(job.id)?.paused).toBeUndefined()
    expect(repository.listTasks(job.id)[0]).toMatchObject({ status: "success", output: "Edited" })
    expect(readFileSync(join(engine.project, "notes.txt"), "utf8")).toBe("edited\n")
  }, 60_000)

  test("the floor reads the agent's rules: a session that allows everything edits as build without asking", async () => {
    model.push(editNotes(), { type: "text", text: "Edited" })
    const session = await adapter.createSession({
      directory: engine.project,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await adapter.prompt({ sessionID: session.id, text: "Edit the notes", agent: "build" })
    // Had the floor failed to read build's rules, it would have refused the edit (RP-05).
    await adapter.waitForIdle(session.id, { timeoutMs: 30_000, unattended: "deny" })
    expect(readFileSync(join(engine.project, "notes.txt"), "utf8")).toBe("edited\n")
  }, 60_000)

  test("the floor: an agent whose rules vanish mid-turn never gets the call it denies", async () => {
    // A project agent that denies edits, removed while its turn is running: the lookup the floor
    // would make no longer finds it.
    const other = join(engine.project, "..", "reviewer-project")
    mkdirSync(join(other, ".opencode", "agent"), { recursive: true })
    writeFileSync(
      join(other, ".opencode", "agent", "reviewer.md"),
      "---\ndescription: Reviews\nmode: primary\npermission:\n  edit: deny\n---\nYou review.\n",
    )
    writeFileSync(join(other, "target.txt"), "untouched\n")
    const session = await adapter.createSession({
      directory: other,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    model.push(
      { type: "tool", name: "shell", input: { command: "sleep 8", description: "Wait" } },
      {
        type: "tool",
        name: "edit",
        input: { path: join(other, "target.txt"), oldString: "untouched", newString: "edited" },
      },
      { type: "text", text: "Tried" },
    )
    await adapter.prompt({ sessionID: session.id, text: "Edit it", agent: "reviewer" })
    await Bun.sleep(1500)
    rmSync(join(other, ".opencode", "agent", "reviewer.md"))
    await adapter.waitForIdle(session.id, { timeoutMs: 60_000 })
    expect(readFileSync(join(other, "target.txt"), "utf8")).toBe("untouched\n")
  }, 90_000)
})
