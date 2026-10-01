import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

/** The binary as the desktop runs it, with its data folder in a temporary place. */
async function harness(data: string, ...args: string[]) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), "engine-data", ...args], {
    env: { ...process.env, XDG_DATA_HOME: data },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(child.stdout).text()
  return { code: await child.exited, answer: JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown> }
}

test("imports a 1.x database into FlupCode's 2.x database and rolls it back, without starting a server", async () => {
  const data = mkdtempSync(join(tmpdir(), "flupcode-engine-data-"))
  folders.push(data)
  const source = join(data, "v1.db")
  const db = new Database(source)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY)")
  db.run("INSERT INTO session VALUES ('ses_1')")
  db.close()
  const target = join(data, "flupcode", "opencode-v2", "opencode.db")

  expect(await harness(data, "import-v1", source)).toEqual({
    code: 0,
    answer: { source, target, sessions: 1, messages: 0 },
  })
  expect(existsSync(target)).toBe(true)
  const rolledBack = await harness(data, "rollback-import")
  expect(rolledBack.code).toBe(0)
  expect(existsSync(target)).toBe(false)

  const missing = await harness(data, "import-v1", join(data, "missing.db"))
  expect(missing.code).toBe(1)
  expect(String(missing.answer.error)).toContain("no OpenCode 1.x database")
})
