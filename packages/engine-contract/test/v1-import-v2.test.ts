import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { importV1History, importV1Memories, rollbackV1Import } from "@flupcode/remote/v1-import"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { startModel } from "../src/model"

/**
 * The explicit 1.x → 2.x import (V2-61), end to end on a real 2.x engine, isolated. The 1.x side is
 * recorded: `fixtures/v1/history.db` is a 1.x database (one session, asked and answered with the stub
 * model) written by FlupCode's last 1.x engine, and a stand-in answers the 1.x `/project` and
 * `/api/memory` routes the memory import reads. A copy is imported into the place FlupCode's 2.x engine
 * opens, 2.x imports it on start, the memories come over, and a rollback puts the 2.x database back.
 * Nothing here opens the reader's own `opencode.db`. Runs on the v2 line:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/v1-import-v2.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-v1-import-")))
const target = join(scratch, "opencode-v2", "opencode.db")
const source = join(scratch, "opencode.db")
copyFileSync(join(import.meta.dir, "..", "fixtures", "v1", "history.db"), source)
const v1Session = (() => {
  const db = new Database(source, { readonly: true })
  const row = db.query("select id from session").get() as { id: string }
  db.close()
  return row.id
})()
const v1 = startV1Memories(scratch)

afterAll(async () => {
  v1.stop(true)
  model.stop()
  rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!run)("importing OpenCode 1.x history into FlupCode's OpenCode 2 engine", () => {
  test("a copy of the running 1.x database is imported by 2.x, memories follow, and a rollback undoes it", async () => {
    const before = digest(source)
    const imported = importV1History({ source, target })
    expect(imported).toMatchObject({ sessions: 1, target })
    expect(imported.messages).toBeGreaterThanOrEqual(2)
    expect(imported.backup).toBeUndefined()

    const v2 = await startEngine({
      modelUrl: model.url,
      env: { OPENCODE_DB: target, OPENCODE_PURE: undefined },
      prepare: async (home) => {
        await installEnginePlugins(join(home, ".config", "opencode"))
      },
    })
    try {
      await until(
        async () => ((await call(v2, "GET", "/api/experimental/migration/v1")) as { status: string }).status,
        (status) => status === "completed",
      )
      const sessions = (await call(v2, "GET", "/api/session")) as { data: Array<{ id: string }> }
      expect(sessions.data.map((session) => session.id)).toContain(v1Session)
      const messages = (await call(v2, "GET", `/api/session/${v1Session}/message`)) as {
        data: Array<{ type: string; text?: string }>
      }
      expect(JSON.stringify(messages.data)).toContain("Asked on 1.x")

      const memories = await until(
        () =>
          importV1Memories({
            from: { url: v1.url.href },
            to: { url: v2.url, authorization: v2.authorization },
          }).catch(() => undefined),
        (result) => result !== undefined,
      )
      expect(memories).toEqual({ found: 2, imported: 2 })
      const listed = (await call(v2, "POST", "/api/rpc/flupcode.memory/list", { input: { status: "active" } })) as {
        output: Array<{ title: string }>
      }
      expect(listed.output.map((memory) => memory.title)).toContain("Lint")
      // Again, nothing new: what 2.x already has is not added twice.
      expect(
        await importV1Memories({
          from: { url: v1.url.href },
          to: { url: v2.url, authorization: v2.authorization },
        }),
      ).toEqual({ found: 2, imported: 0 })
    } finally {
      await v2.stop()
    }

    // The 1.x database was only read.
    expect(digest(source)).toBe(before)
    const again = importV1History({ source, target })
    expect(again.backup).toBeDefined()
    const rolledBack = rollbackV1Import({ target })
    expect(rolledBack.restored).toBe(again.backup)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(rolledBack.aside)).toBe(true)
  }, 240_000)
})

/**
 * The routes of a 1.x engine `importV1Memories` reads, answering as 1.x did with one global memory and
 * one for the project 1.x knew.
 */
function startV1Memories(project: string) {
  const memory = (scope: "global" | "project", title: string, content: string) => ({
    id: `mem_${title.toLowerCase()}`,
    scope,
    scopeID: scope === "global" ? "global" : project,
    kind: "fact",
    title,
    content,
    tags: [],
    status: "active",
    confidence: 1,
    importance: 0.5,
    ...(scope === "project" ? { directory: project } : {}),
  })
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/project") return Response.json([{ worktree: project }])
      if (url.pathname !== "/api/memory") return new Response("not found", { status: 404 })
      if (url.searchParams.get("status") !== "active") return Response.json({ data: [] })
      return Response.json({
        data: url.searchParams.get("location[directory]")
          ? [memory("project", "Branch", "Releases are cut from power")]
          : [memory("global", "Lint", "Run bun run lint before pushing")],
      })
    },
  })
}

function digest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

async function call(engine: Engine, method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  return response.json() as Promise<unknown>
}

async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (match(value)) return value
    if (Date.now() > deadline) throw new Error(`Never matched: ${JSON.stringify(value).slice(0, 300)}`)
    await Bun.sleep(250)
  }
}
