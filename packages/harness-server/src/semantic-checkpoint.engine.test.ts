import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { Run } from "./types"

/**
 * Checkpoints as points in the work (CL-3), on the pinned OpenCode 2 engine: a point names the
 * conversation it was taken in, restoring it takes the files and the conversation back together or
 * not at all, and a run can be forked from one. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/semantic-checkpoint.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let repository: SqliteRoutineRepository
let scheduler: RoutineScheduler
let handler: ReturnType<typeof createHarnessHandler>
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) })
  engine = await startEngine({
    modelUrl: model.url,
    price: { input: 3, output: 15 },
    env: {
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${server.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    flupcodePlugins: true,
  })
  scheduler = new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization })
  handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
}, 180_000)

beforeEach(() => model.reset())

afterAll(async () => {
  await scheduler?.stopAll()
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  model.stop()
})

/** A turn that writes one file through the shell, then answers. */
const writes = (file: string, content: string) =>
  model.push(
    { type: "tool", name: "shell", input: { command: `mkdir -p "$(dirname ${file})" && printf ${content} > ${file}`, description: `Write ${file}` } },
    { type: "text", text: `Wrote ${file}` },
  )

describe.skipIf(!run)("semantic checkpoints on an OpenCode 2 engine", () => {
  test("a run's checkpoints name the task's conversation, carry a summary of the facts as versions, and read their cost from the ledger", async () => {
    const directory = project("run-points")
    writes("one.txt", "1")
    model.push({ type: "text", text: "Decided: one.txt" })
    writes("two.txt", "2")
    model.push({ type: "text", text: "Decided: two.txt" })
    const started = await scheduler.runTasks({
      tasks: [
        { name: "first", prompt: "Write one" },
        { name: "second", prompt: "Write two" },
      ],
      directory,
    })
    expect(await settle(started.id)).toMatchObject({ status: "success" })
    const tasks = repository.listTasks(started.id)
    await until(() => tasks.every((task) => repository.usageEvents(task.sessionID!).length >= 2))

    const points = (await call<Point[]>("GET", `/harness/checkpoints?runID=${started.id}`)).reverse()
    expect(points.map((point) => point.title)).toEqual(["first", "second"])
    for (const [index, point] of points.entries()) {
      expect(point.sessionID).toBe(tasks[index]!.sessionID)
      // The newest message of the task's session when the point was taken: nothing follows it.
      const since = await scheduler.engine.conversationSince(point.sessionID!, point.messageID!)
      expect(since).toEqual({ state: "kept", prompts: 0 })
    }
    // One summary document for the run, a version per point, written from the facts (labelled so).
    expect(points.map((point) => point.decided?.by)).toEqual(["facts", "facts"])
    expect(points.map((point) => point.decided?.version)).toEqual([1, 2])
    expect(points[0]!.decided!.text).toContain("After first: 1 of 2 tasks done.")
    expect(points[0]!.decided!.text).toContain("Files changed in this step: one.txt.")
    expect(points[1]!.decided!.text).toContain("- second: success")
    const summaries = points.map((point) => repository.getArtifact(point.summaryArtifactID!)!)
    expect(summaries[1]!.logicalID).toBe(summaries[0]!.logicalID)
    expect(summaries.map((artifact) => artifact.kind)).toEqual(["checkpoint", "checkpoint"])
    // The cost the run had reached by each point, read from the ledger: the second includes the first.
    const usd = points.map((point) => point.cost!.money.reduce((sum, line) => sum + line.usd, 0))
    expect(usd[0]).toBeGreaterThan(0)
    expect(usd[1]).toBeGreaterThan(usd[0]!)
  }, 120_000)

  test("restoring a checkpoint taken in a session takes the files and the conversation back together", async () => {
    const directory = project("together")
    const session = await scheduler.engine.createSession({ directory })
    await turn(session.id, directory, "a.txt", "A")
    const point = await call<Point>("POST", "/harness/checkpoints", { directory, title: "After a", sessionID: session.id })
    await turn(session.id, directory, "b.txt", "B")
    expect(existsSync(join(directory, "b.txt"))).toBe(true)

    const plan = await call<Plan>("GET", `/harness/checkpoints/${point.id}/plan`)
    expect(plan.files).toEqual({ write: [], remove: ["b.txt"] })
    expect(plan.conversation).toMatchObject({ state: "kept", sessionID: session.id, prompts: 1 })

    const done = await call<{ safety: Point }>("POST", `/harness/checkpoints/${point.id}/restore`)
    expect(existsSync(join(directory, "b.txt"))).toBe(false)
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("A")
    expect(await prompts(session.id)).toEqual(["Write a.txt"])
    expect(await scheduler.engine.conversationSince(session.id, point.messageID!)).toEqual({ state: "kept", prompts: 0 })
    // The way back from it is a checkpoint like any other.
    expect(repository.getCheckpoint(done.safety.id)?.title).toBe('Before restoring "After a"')
  }, 120_000)

  test("when the engine refuses the conversation half, the files are not touched either", async () => {
    const directory = project("engine-refuses")
    const session = await scheduler.engine.createSession({ directory })
    await turn(session.id, directory, "a.txt", "A")
    const point = await call<Point>("POST", "/harness/checkpoints", { directory, title: "After a", sessionID: session.id })
    await turn(session.id, directory, "b.txt", "B")
    // A turn still running: the engine refuses to revert a busy session.
    model.push({ type: "tool", name: "shell", input: { command: "sleep 4", description: "Wait" } }, { type: "text", text: "Waited" })
    await scheduler.engine.prompt({ sessionID: session.id, directory, text: "Wait a little" })
    await until(async () => await scheduler.engine.isBusy(session.id))
    const before = repository.listCheckpoints({ directory }).length

    const refused = await request("POST", `/harness/checkpoints/${point.id}/restore`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toMatch(/^The conversation could not be taken back: .*busy.*Nothing was changed\.$/)
    expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("B")
    expect(repository.listCheckpoints({ directory })).toHaveLength(before)
    await scheduler.engine.waitForIdle(session.id, { timeoutMs: 30_000 })
    expect(await prompts(session.id)).toEqual(["Write a.txt", "Write b.txt", "Wait a little"])
  }, 120_000)

  test("when the files cannot be written, the conversation's revert is undone too", async () => {
    const directory = project("files-refuse")
    const session = await scheduler.engine.createSession({ directory })
    await turn(session.id, directory, "locked/x.txt", "one")
    const point = await call<Point>("POST", "/harness/checkpoints", { directory, title: "After x", sessionID: session.id })
    await turn(session.id, directory, "b.txt", "B")
    // Changed by hand in a folder that can no longer be written: the session's revert does not touch
    // it, the checkpoint's files must, and cannot.
    writeFileSync(join(directory, "locked/x.txt"), "by hand")
    chmodSync(join(directory, "locked"), 0o555)
    try {
      const refused = await request("POST", `/harness/checkpoints/${point.id}/restore`)
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as { error: string }).error).toMatch(/^The files could not be restored: .*Nothing was changed\.$/)
    } finally {
      chmodSync(join(directory, "locked"), 0o755)
    }
    expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("B")
    expect(readFileSync(join(directory, "locked/x.txt"), "utf8")).toBe("by hand")
    expect(await prompts(session.id)).toEqual(["Write locked/x.txt", "Write b.txt"])
    expect(await scheduler.engine.conversationSince(session.id, point.messageID!)).toEqual({
      state: "kept",
      prompts: 1,
      revertTo: expect.any(String),
    })
  }, 120_000)

  test("with a small model configured, the summary is the model's, labelled as such", async () => {
    const directory = project("small-model")
    const summarising = new RoutineScheduler({
      repository,
      engineURL: engine.url,
      authorization: engine.authorization,
      summaryModel: () => ({ providerID: "stub", id: "stub-model" }),
    })
    writes("one.txt", "1")
    model.push({ type: "text", text: "Decided to keep one.txt as it is." })
    const started = await summarising.runTasks({ tasks: [{ name: "only", prompt: "Write one" }], directory })
    expect(await settle(started.id)).toMatchObject({ status: "success" })
    const [point] = await call<Point[]>("GET", `/harness/checkpoints?runID=${started.id}`)
    expect(point!.decided).toMatchObject({ by: "model", text: "Decided to keep one.txt as it is." })
    // What it was asked is the facts.
    expect(JSON.stringify(model.requests.at(-1))).toContain("After only: 1 of 1 tasks done.")
    await summarising.stopAll()
  }, 120_000)

  test("forking from a run's checkpoint starts a child run from that point's files", async () => {
    const directory = project("fork")
    for (const name of ["a", "b", "c"]) {
      writes(`${name}.txt`, name)
      model.push({ type: "text", text: `Decided: ${name}` })
    }
    const parent = await scheduler.runTasks({
      tasks: ["a", "b", "c"].map((name) => ({ name, prompt: `Write ${name}` })),
      directory,
    })
    expect(await settle(parent.id)).toMatchObject({ status: "success" })
    const after = repository.listCheckpoints({ runID: parent.id }).find((point) => point.title === "a")!

    const plan = await call<{ kept: Array<{ name: string }>; tasks: Array<{ name: string }>; plan: Plan["files"] }>(
      "GET",
      `/harness/checkpoints/${after.id}/fork`,
    )
    expect(plan.kept.map((task) => task.name)).toEqual(["a"])
    expect(plan.tasks.map((task) => task.name)).toEqual(["b", "c"])
    expect(plan.plan).toEqual({ write: [], remove: ["b.txt", "c.txt"] })

    for (const name of ["b", "c"]) {
      writes(`${name}.txt`, `${name}2`)
      model.push({ type: "text", text: `Decided: ${name} again` })
    }
    const child = await call<Run>("POST", `/harness/checkpoints/${after.id}/fork`)
    expect(child.forkOf).toEqual({ runID: parent.id, checkpointID: after.id })
    expect(await settle(child.id)).toMatchObject({ status: "success", forkOf: { runID: parent.id, checkpointID: after.id } })
    const tasks = repository.listTasks(child.id)
    expect(tasks.map((task) => [task.name, task.status, task.attempt])).toEqual([
      ["a", "success", 1],
      ["b", "success", 1],
      ["c", "success", 1],
    ])
    // Carried over, not run: no session of its own, and what it concluded is what `b` was handed.
    expect(tasks[0]!.sessionID).toBeUndefined()
    expect(tasks[1]!.sessionID).toBeDefined()
    expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("b2")
    // Its first summary counts the files from the point it was forked from.
    const [first] = (await call<Point[]>("GET", `/harness/checkpoints?runID=${child.id}`)).reverse()
    expect(first!.decided!.text).toContain("Files changed in this step: b.txt.")
    // The parent is as it was.
    expect(repository.listTasks(parent.id).map((task) => task.status)).toEqual(["success", "success", "success"])
    expect(repository.listCheckpoints({ directory }).some((point) => point.title === 'Before forking from "a"')).toBe(true)
  }, 180_000)
})

type Point = {
  id: string
  title: string
  sessionID?: string
  messageID?: string
  summaryArtifactID?: string
  decided?: { text: string; by: "facts" | "model"; version: number }
  cost?: { money: Array<{ usd: number }> }
}
type Plan = { files: { write: string[]; remove: string[] }; conversation: { state: string } }

/** A folder of its own, a repository with one commit, so every test's checkpoints are its own. */
function project(name: string) {
  const directory = join(engine.project, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "README.md"), name)
  // The memory plugin's extraction asks the model after a turn, which would take a scripted reply.
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ memory: { auto: false } }))
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=test@flupcode.local", "-c", "user.name=Test", ...args], { cwd: directory })
  git("init", "-q")
  git("add", "-A")
  git("commit", "-q", "-m", "start")
  return directory
}

/** One prompt in a session that writes a file, waited for. */
async function turn(sessionID: string, directory: string, file: string, content: string) {
  writes(file, content)
  await scheduler.engine.prompt({ sessionID, directory, text: `Write ${file}` })
  await scheduler.engine.waitForIdle(sessionID, { timeoutMs: 30_000 })
}

/** What the session was asked, oldest first. */
async function prompts(sessionID: string) {
  const messages = await scheduler.engine.messages(sessionID)
  return messages.flatMap((message) =>
    message.info?.role === "user" ? (message.parts ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])) : [],
  )
}

function request(method: string, path: string, body?: unknown) {
  return handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: "Bearer ui-token", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function call<T>(method: string, path: string, body?: unknown) {
  const response = await request(method, path, body)
  const payload = (await response.json()) as { data?: T; error?: string }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${payload.error}`)
  return payload.data as T
}

/** The run once it is no longer running. */
async function settle(runID: string): Promise<Run> {
  await until(() => repository.getRun(runID)?.status !== "running", 90_000)
  return repository.getRun(runID)!
}

async function until(check: () => boolean | Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(100)
}
