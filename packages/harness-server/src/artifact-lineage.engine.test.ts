import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { Artifact } from "./types"

/**
 * Artifact lineage and versions against the pinned OpenCode 2 engine with FlupCode's plugins (RP-03).
 * A workflow task calls `artifact_write` twice on one file; the plugin reports each write to a real
 * harness handler, which works out the run and the task from the session. Run it as CI's engine job
 * does:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/artifact-lineage.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const repository = new SqliteRoutineRepository(":memory:")
// The engine needs the harness's address before it starts, and the handler needs the engine's.
let handle = async (_request: Request) => new Response("starting", { status: 503 })
const harness = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handle(request) })
const indexed: Array<{ status: number; authorization: string | null }> = []
let contract: ContractEngine
let scheduler: RoutineScheduler

beforeAll(async () => {
  if (!run) return
  contract = await startEngine({
    modelUrl: model.url,
    env: {
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${harness.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    flupcodePlugins: true,
  })
  scheduler = new RoutineScheduler({ repository, engineURL: contract.url, authorization: contract.authorization })
  const handler = createHarnessHandler(repository, scheduler, { token: "ui-token", pluginToken: "plugin-token" })
  handle = async (request) => {
    const response = await handler(request)
    if (new URL(request.url).pathname === "/harness/artifacts/index")
      indexed.push({ status: response.status, authorization: request.headers.get("authorization") })
    return response
  }
}, 120_000)

beforeEach(() => model.reset())

afterAll(async () => {
  await contract?.stop()
  model.stop()
  harness.stop(true)
  repository.close()
})

describe.skipIf(!run)("artifact lineage on an OpenCode 2 engine", () => {
  test("a document a run's task writes twice is one document with two versions, each opening its run and message", async () => {
    model.push(
      { type: "tool", name: "artifact_write", input: { title: "Report", filename: "report.md", content: "# Report\n\nfirst" } },
      { type: "tool", name: "artifact_write", input: { title: "Report", filename: "report.md", content: "# Report\n\nsecond" } },
      { type: "text", text: "Kept it" },
      { type: "text", text: "Decided: kept" },
    )
    const started = await repositoryRun()
    const [task] = repository.listTasks(started)
    expect(indexed.map((entry) => entry.status)).toEqual([201, 201])
    expect(indexed.every((entry) => entry.authorization === "Bearer plugin-token")).toBe(true)

    // One row per document on the list, with how many versions it has.
    const listed = (await read<Artifact[]>(`/harness/artifacts?directory=${encodeURIComponent(contract.project)}`)).filter((artifact) => artifact.kind === "document")
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ title: "Report", version: 2, versions: 2, content: "# Report\n\nsecond" })

    // Each version names the run, the task, the task's session and the message whose step wrote it.
    const history = await read<Artifact[]>(`/harness/artifacts/${listed[0]!.id}/versions`)
    const writers = await writerMessages(task!.sessionID!)
    expect(writers).toHaveLength(2)
    expect(history.map((version) => version.version)).toEqual([2, 1])
    for (const [index, version] of history.entries())
      expect(version).toMatchObject({
        logicalID: listed[0]!.logicalID,
        runID: started,
        taskID: task!.id,
        sessionID: task!.sessionID,
        messageID: writers[1 - index],
      })
  }, 90_000)

  test("the report is the plugins' to make, names a file in the documents folder, and never chooses the run", async () => {
    const run = repository.startRun({ type: "manual" }, Date.now(), contract.project)
    const chat = (
      (await (
        await fetch(`${contract.url}/api/session`, {
          method: "POST",
          headers: { authorization: contract.authorization, "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as { data: { id: string } }
    ).data.id
    await Bun.write(join(contract.project, ".flupcode", "artifacts", "notes.md"), "# Notes")
    await Bun.write(join(contract.project, "secret.txt"), "not a document")
    const report = (token: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${harness.port}/harness/artifacts/index`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", directory: contract.project, sessionID: chat, ...body }),
      })

    expect((await report("ui-token", { path: ".flupcode/artifacts/notes.md" })).status).toBe(403)
    expect((await report("plugin-token", { path: "secret.txt" })).status).toBe(404)
    expect((await report("plugin-token", { path: ".flupcode/artifacts/../../secret.txt" })).status).toBe(404)
    expect((await report("plugin-token", { path: ".flupcode/artifacts/notes.md", sessionID: "ses_unknown" })).status).toBe(404)
    // A chat works for no run: a run or a task in the report is not taken.
    const kept = await report("plugin-token", { path: ".flupcode/artifacts/notes.md", runID: run.id, taskID: "task_1" })
    expect(kept.status).toBe(201)
    const artifact = ((await kept.json()) as { data: Artifact }).data
    expect(artifact).toMatchObject({ sessionID: chat, title: "Notes", version: 1 })
    expect(artifact.runID).toBeUndefined()
    expect(artifact.taskID).toBeUndefined()
    // The plugins' bearer reads nothing back.
    const read = await fetch(`http://127.0.0.1:${harness.port}/harness/artifacts/${artifact.id}/versions`, {
      headers: { authorization: "Bearer plugin-token" },
    })
    expect(read.status).toBe(403)
  }, 60_000)
})

async function repositoryRun() {
  const started = await scheduler.runTasks({ tasks: [{ name: "write", prompt: "Write the report" }], directory: contract.project })
  await until(() => repository.getRun(started.id)?.status === "success" || undefined, 60_000)
  return started.id
}

/** A harness read with the app's bearer. */
async function read<T>(path: string) {
  const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, { headers: { authorization: "Bearer ui-token" } })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: T }).data
}

/** The assistant messages that called `artifact_write`, oldest first, as the engine lists them. */
async function writerMessages(sessionID: string) {
  const response = await fetch(`${contract.url}/api/session/${sessionID}/message?limit=200`, {
    headers: { authorization: contract.authorization },
  })
  const messages = ((await response.json()) as {
    data: Array<{ id: string; content?: Array<{ type: string; name?: string }> }>
  }).data
  return messages
    .filter((message) => (message.content ?? []).some((part) => part.type === "tool" && part.name === "artifact_write"))
    .map((message) => message.id)
    // The engine's ids sort in the order it made them; its list is not oldest first.
    .sort()
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(50)
  }
}
