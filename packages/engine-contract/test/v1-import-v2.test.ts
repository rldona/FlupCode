import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { importV1History, importV1Memories, rollbackV1Import } from "@flupcode/remote/v1-import"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { startModel } from "../src/model"

/**
 * The explicit 1.x → 2.x import (V2-61), end to end on real engines, isolated: FlupCode's 1.x engine
 * from this checkout keeps a session and memories in its own temporary home; its database is copied
 * while it runs into the place FlupCode's 2.x engine opens, 2.x imports that copy on start, the
 * memories come over 1.x's `/api/memory`, and a rollback puts the 2.x database back. Nothing here
 * opens the reader's own `opencode.db`. Runs on the v2 line:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/v1-import-v2.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-v1-import-")))
const target = join(scratch, "opencode-v2", "opencode.db")
let v1: Engine
let v1Session: string

beforeAll(async () => {
  if (!run) return
  v1 = await startEngine({ modelUrl: model.url, line: "v1" })
  const created = (await call(v1, "POST", `/session?directory=${encodeURIComponent(v1.project)}`, {})) as { id: string }
  v1Session = created.id
  model.push({ type: "text", text: "Answered on 1.x" })
  await call(v1, "POST", `/session/${v1Session}/message?directory=${encodeURIComponent(v1.project)}`, {
    parts: [{ type: "text", text: "Asked on 1.x" }],
  })
  await call(v1, "POST", "/api/memory", { scope: "global", title: "Lint", content: "Run bun run lint before pushing" })
  await call(v1, "POST", `/api/memory?${new URLSearchParams({ "location[directory]": v1.project })}`, {
    scope: "project",
    title: "Branch",
    content: "Releases are cut from power",
  })
}, 180_000)

afterAll(async () => {
  await v1?.stop()
  model.stop()
  rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!run)("importing OpenCode 1.x history into FlupCode's OpenCode 2 engine", () => {
  test("a copy of the running 1.x database is imported by 2.x, memories follow, and a rollback undoes it", async () => {
    const source = v1Database(v1)
    const before = digest(source)
    const imported = importV1History({ source, target })
    expect(imported).toMatchObject({ sessions: 1, target })
    expect(imported.messages).toBeGreaterThanOrEqual(2)
    expect(imported.backup).toBeUndefined()

    const v2 = await startEngine({
      modelUrl: model.url,
      line: "v2",
      env: { OPENCODE_DB: target, OPENCODE_PURE: undefined },
      prepare: async (home) => {
        await installEnginePlugins(join(home, ".config", "opencode"), "v2")
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
            from: { url: v1.url, authorization: v1.authorization },
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
          from: { url: v1.url, authorization: v1.authorization },
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

/** FlupCode's 1.x engine from source runs on the local channel, whose database is named for it. */
function v1Database(engine: Engine) {
  const folder = join(engine.home, ".local", "share", "opencode")
  return ["opencode.db", "opencode-local.db"].map((name) => join(folder, name)).find((path) => existsSync(path))!
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
