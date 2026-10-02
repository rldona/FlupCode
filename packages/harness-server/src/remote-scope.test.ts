import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { createBrowserMcpGate } from "./browser-mcp"
import { createBrowserPolicy } from "./browser-policy"
import { createPairing } from "./pairing"
import { remoteScopeAllows } from "./remote-scope"
import { REFUSED } from "./remote-scope.fixture"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const dir = mkdtempSync(join(tmpdir(), "flupcode-remote-scope-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A harness with every surface a phone must not reach, so a refusal is the scope's and not a 404. */
function scoped() {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  const policy = createBrowserPolicy(repository)
  const handler = createHarnessHandler(repository, scheduler, {
    token: "ui-token",
    pluginToken: "plugin-token",
    remoteToken: "remote-token",
    pairing: createPairing({ file: join(dir, `paired-${crypto.randomUUID()}.json`) }),
    actions: {
      list: () => ({ profiles: [], rejected: [] }),
      run: async () => ({ status: "dry-run" }) as never,
      policy,
    },
    browserPolicy: policy,
    planExit: async () => ({ approved: false }),
    browserMcp: createBrowserMcpGate({ policy, ask: async () => undefined }),
  })
  const call = (token: string, method: string, path: string, body: unknown = method === "GET" ? undefined : {}) =>
    handler(
      new Request(`http://127.0.0.1:4097${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { repository, call }
}


describe("the remote token's scope (HE-02)", () => {
  test("refuses every route outside the allow-list, before it runs, whatever it is", async () => {
    const { repository, call } = scoped()
    for (const [method, path] of REFUSED) {
      const refused = await call("remote-token", method, path)
      expect([method, path, refused.status]).toEqual([method, path, 403])
      expect((await refused.json()).code).toBe("out_of_scope")
    }
    // Nothing was started, written or paired on the way.
    expect(repository.list()).toEqual([])
    expect(repository.listRuns()).toEqual([])
    expect(repository.listArtifacts()).toEqual([])
    repository.close()
  })

  test("the same routes are the UI's: a refusal over remote control is the scope, not the route", async () => {
    const { repository, call } = scoped()
    const refusedForUi = []
    for (const [method, path] of REFUSED) {
      const response = await call("ui-token", method, path)
      if (response.status === 403 && (await response.json()).code === "out_of_scope") refusedForUi.push(path)
    }
    expect(refusedForUi).toEqual([])
    repository.close()
  })

  test("reads runs and artifacts, lets a gate through and stops a run", async () => {
    const { repository, call } = scoped()
    const gate = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(gate.id, [{ name: "plan", prompt: "go" }])
    repository.awaitRun(gate.id)
    const held = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(held.id, [{ name: "ship", prompt: "go" }])
    repository.awaitRun(held.id)
    const report = repository.addArtifact({ kind: "report", title: "notes", producer: "harness", content: "kept" })

    for (const path of [
      "/harness/health",
      "/harness/runs",
      `/harness/runs/${gate.id}`,
      `/harness/runs/${gate.id}/tasks`,
      `/harness/runs/${gate.id}/activity`,
      `/harness/runs/${gate.id}/files`,
      `/harness/runs/${gate.id}/tools`,
      "/harness/artifacts",
      `/harness/artifacts/${report.id}`,
      `/harness/artifacts/${report.id}/raw`,
      `/harness/artifacts/${report.id}/versions`,
      `/harness/artifacts/${report.id}/export?format=md`,
    ]) {
      const read = await call("remote-token", "GET", path)
      expect([path, read.status]).toEqual([path, 200])
    }
    // What a run spent is the route's answer, whatever it is: the scope lets it through.
    expect((await call("remote-token", "GET", `/harness/usage/runs/${gate.id}`)).status).not.toBe(403)

    const approved = await call("remote-token", "POST", `/harness/runs/${gate.id}/approve`)
    expect(approved.status).toBe(200)
    expect((await approved.json()).data.status).toBe("running")
    const stopped = await call("remote-token", "POST", `/harness/runs/${held.id}/stop`)
    expect(stopped.status).toBe(200)
    expect(repository.getRun(held.id)?.status).toBe("stopped")
    // No engine answers here, so the approved run fails on its own; it must not outlive the database.
    await scheduledEnd(repository, gate.id)
    repository.close()
  })

  test("the event stream carries runs and artifacts, not the reader's stash or routines", async () => {
    const { repository, call } = scoped()
    const response = await call("remote-token", "GET", "/harness/events")
    const reader = response.body!.getReader()
    await reader.read()
    repository.addToStash("a private prompt")
    repository.create({ name: "Nightly", description: "", prompt: "secret", schedule: { type: "manual" } })
    const run = repository.startRun({ type: "manual" }, Date.now())
    const seen = await readUntil(reader, run.id)
    expect(seen).toContain(`"type":"run.started"`)
    expect(seen).not.toContain("a private prompt")
    expect(seen).not.toContain("Nightly")
    await reader.cancel()
    repository.close()
  })

  test("the allow-list itself", () => {
    expect(remoteScopeAllows("GET", ["harness", "runs"])).toBe(true)
    expect(remoteScopeAllows("POST", ["harness", "runs", "r", "approve"])).toBe(true)
    expect(remoteScopeAllows("POST", ["harness", "runs", "r", "stop"])).toBe(true)
    expect(remoteScopeAllows("GET", ["api", "session"])).toBe(false)
    expect(remoteScopeAllows("HEAD", ["harness", "runs"])).toBe(false)
  })
})

async function scheduledEnd(repository: SqliteRoutineRepository, runID: string) {
  const deadline = Date.now() + 10_000
  while (repository.getRun(runID)?.status === "running" && Date.now() < deadline) await Bun.sleep(10)
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 5_000
  while (!text.includes(marker) && Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  return text
}
