import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importV1History, openCodeV1Database, rollbackV1Import } from "./v1-import"

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

function scratch() {
  const folder = mkdtempSync(join(tmpdir(), "flupcode-v1-import-unit-"))
  folders.push(folder)
  return folder
}

/** A database with 1.x's session and message tables, in write-ahead mode like the engine's. */
function v1Database(folder: string, sessions: number) {
  const path = join(folder, "opencode.db")
  const db = new Database(path)
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT)")
  for (let index = 0; index < sessions; index++) {
    db.run("INSERT INTO session VALUES (?)", [`ses_${index}`])
    db.run("INSERT INTO message VALUES (?, ?)", [`msg_${index}`, `ses_${index}`])
  }
  return { path, db }
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

describe("importV1History", () => {
  test("copies a 1.x database, open and in write-ahead mode, without writing it", () => {
    const folder = scratch()
    const source = v1Database(folder, 2)
    const before = digest(source.path)
    const target = join(folder, "v2", "opencode.db")

    expect(importV1History({ source: source.path, target })).toEqual({
      source: source.path,
      target,
      sessions: 2,
      messages: 2,
    })
    // Rows still in the 1.x write-ahead log are part of the copy.
    const copy = new Database(target, { readonly: true })
    expect(copy.query<{ n: number }, []>("SELECT count(*) AS n FROM session").get()?.n).toBe(2)
    copy.close()
    expect(digest(source.path)).toBe(before)
    source.db.close()
  })

  test("keeps what FlupCode's 2.x database held, and a rollback puts it back", () => {
    const folder = scratch()
    const target = join(folder, "v2", "opencode.db")
    const first = v1Database(join(folder), 1)
    importV1History({ source: first.path, target, now: () => 1 })
    first.db.run("INSERT INTO session VALUES ('ses_late')")
    const second = importV1History({ source: first.path, target, now: () => 2 })
    expect(second).toMatchObject({ sessions: 2, backup: `${target}.bak-2` })

    const rolledBack = rollbackV1Import({ target, now: () => 3 })
    expect(rolledBack).toEqual({ target, aside: `${target}.rolled-back-3`, restored: `${target}.bak-2` })
    const restored = new Database(target, { readonly: true })
    expect(restored.query<{ n: number }, []>("SELECT count(*) AS n FROM session").get()?.n).toBe(1)
    restored.close()
    expect(existsSync(`${target}.rolled-back-3`)).toBe(true)
    first.db.close()
  })

  test("rolling back a first import leaves no 2.x database, only the one set aside", () => {
    const folder = scratch()
    const target = join(folder, "v2", "opencode.db")
    const source = v1Database(folder, 1)
    importV1History({ source: source.path, target })
    const rolledBack = rollbackV1Import({ target, now: () => 5 })
    expect(rolledBack.restored).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    expect(existsSync(rolledBack.aside)).toBe(true)
    source.db.close()
  })

  test("refuses a missing file or one that is not a 1.x database, and leaves the target alone", () => {
    const folder = scratch()
    const target = join(folder, "v2", "opencode.db")
    expect(() => importV1History({ source: join(folder, "missing.db"), target })).toThrow(/no OpenCode 1.x database/)
    const other = new Database(join(folder, "other.db"))
    other.run("CREATE TABLE notes (id TEXT)")
    other.close()
    expect(() => importV1History({ source: join(folder, "other.db"), target })).toThrow(/not an OpenCode 1.x database/)
    expect(existsSync(target)).toBe(false)
  })

  test("defaults to where a released 1.x engine keeps its database", () => {
    expect(openCodeV1Database({ XDG_DATA_HOME: "/data" })).toBe(join("/data", "opencode", "opencode.db"))
  })
})
