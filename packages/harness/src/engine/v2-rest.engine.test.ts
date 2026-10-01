import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import type { EngineClient } from "../client"
import { setEngineTransport } from "../transport"
import { EngineError } from "./error"
import { createV2Domains } from "./v2"

/**
 * The rest of the OpenCode 2 adapter against a real 2.x engine (V2-11 groundwork): health, paths,
 * events, agents, commands, skills, files, version control, the reply suggestion, and what 2.x no
 * longer has reading as the app's empty state. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-rest.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url })
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  domains = createV2Domains(engine.url)
})

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

// Compiles only while the 2.x adapter has every domain the app's client has.
test("the OpenCode 2 adapter is a whole EngineClient", () => {
  const client: EngineClient = createV2Domains("http://127.0.0.1:1")
  expect(Object.keys(client).length).toBeGreaterThan(20)
})

describe.skipIf(!run)("the rest of the OpenCode 2 adapter", () => {
  test("health names the engine's version, and paths its folder", async () => {
    expect(await domains.health.get()).toEqual({ healthy: true, version: engine.detected.version })
    expect((await domains.paths()).directory).toBe(engine.project)
  })

  test("the event stream is /api/event, and the 1.x folder stream waits quietly for its signal", async () => {
    const controller = new AbortController()
    const events = domains.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    expect((await events.next()).value?.type).toBe("server.connected")
    controller.abort()

    const folder = new AbortController()
    const quiet = domains.event.subscribeDirectory(engine.project, { signal: folder.signal })[Symbol.asyncIterator]()
    const next = quiet.next()
    expect(await Promise.race([next.then(() => "ended"), Bun.sleep(200).then(() => "waiting")])).toBe("waiting")
    folder.abort()
    expect((await next).done).toBe(true)
  })

  test("agents, commands and skills are listed in the app's shape", async () => {
    const agents = (await domains.agent.list({ location: { directory: engine.project } })).data
    expect(agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(["build", "plan"]))
    expect(await domains.agent.listFor(engine.project)).toEqual(agents)
    expect(Array.isArray((await domains.command.list()).data)).toBe(true)
    expect(Array.isArray((await domains.skill.list()).data)).toBe(true)
  })

  test("files are found and listed inside the folder", async () => {
    mkdirSync(join(engine.project, "docs"), { recursive: true })
    writeFileSync(join(engine.project, "docs", "findme.md"), "hello\n")
    const listed = await domains.file.list({ directory: engine.project, path: "docs" })
    expect(listed.map((entry) => entry.path)).toContain("docs/findme.md")
    const found = await domains.file.find({ query: "findme" })
    expect(found.data.map((entry) => entry.path)).toContain("docs/findme.md")
  })

  test("version control reads the branch, the changed files and their patch", async () => {
    const repo = join(engine.project, "repo")
    mkdirSync(repo, { recursive: true })
    await git(repo, "init", "-q", "-b", "main")
    writeFileSync(join(repo, "a.txt"), "one\n")
    await git(repo, "add", ".")
    await git(repo, "-c", "user.email=contract@example.com", "-c", "user.name=Contract", "commit", "-qm", "init")
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n")

    // 2.x reads the branch in the background: the first answer can be empty, and the app hears
    // `vcs.branch.updated` when it is known.
    expect(
      await until(
        () => domains.vcs.get(repo),
        (info) => !!info.branch,
      ),
    ).toMatchObject({ branch: "main" })
    expect(await domains.vcs.status(repo)).toEqual([{ file: "a.txt", additions: 1, deletions: 0, status: "modified" }])
    const diff = await domains.vcs.diff(repo)
    expect(JSON.stringify(diff)).toContain("+two")
  })

  test("a reply suggestion is generated without a session", async () => {
    // 2.x generates in its global config location, whose catalog loads on first use, so the first
    // asks can fail until it has; the app treats a suggestion as best-effort anyway.
    const before = (await domains.session.list({ directory: engine.project })).data.length
    const reply = await until(
      () => {
        model.reset()
        model.push({ type: "text", text: "  Sounds good  " })
        return domains.suggest
          .reply({
            parentID: "ses_unused",
            model: { providerID: "stub", id: "stub-model" },
            prompt: "What next?",
            system: "Suggest the next message.",
          })
          .catch(() => undefined)
      },
      (value) => value !== undefined,
    )
    expect(reply).toBe("Sounds good")
    expect((await domains.session.list({ directory: engine.project })).data.length).toBe(before)
  })

  test("what 2.x no longer has reads empty, and so does memory without FlupCode's plugin", async () => {
    // This engine runs without plugins: memory is the plugin's (V2-32), so its lists read empty and a
    // write fails with the engine's own error.
    expect(await domains.memory.list()).toEqual({ data: [] })
    expect(await domains.memory.create({ title: "x", content: "y" }).catch((cause: unknown) => cause)).toBeInstanceOf(
      EngineError,
    )
    expect(await domains.tools()).toEqual([])
    expect(await domains.console.active()).toEqual({ consoleManagedProviders: [], switchableOrgCount: 0 })
    await domains.reload()
  })
})

async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (match(value)) return value
    if (Date.now() > deadline) throw new Error(`Never matched: ${JSON.stringify(value).slice(0, 300)}`)
    await Bun.sleep(100)
  }
}

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" })
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
}
