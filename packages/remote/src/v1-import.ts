import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

/**
 * Bringing OpenCode 1.x history into the OpenCode 2 engine FlupCode starts (V2-61), only when asked.
 *
 * 2.x imports 1.x sessions from the database it opens, once, when it starts, and changes that database
 * one way as it goes. FlupCode's 2.x engine opens a database of its own (`openCodeV2Database`), so the
 * import is: copy 1.x's database into that place while no 2.x engine has it open, and let 2.x import
 * the copy on its next start. The 1.x file is opened read-only and never written; what was in FlupCode's
 * 2.x database before is kept beside it, and a rollback puts it back. Bun only: `bun:sqlite`.
 */
export function importV1History(input: { source?: string; target: string; now?: () => number }) {
  const source = input.source ?? openCodeV1Database()
  if (!existsSync(source)) throw new Error(`There is no OpenCode 1.x database at ${source}`)
  const stamp = (input.now ?? Date.now)()
  const temp = `${input.target}.importing-${process.pid}`
  removeDatabase(temp)
  mkdirSync(dirname(input.target), { recursive: true })
  // A consistent copy of a database another engine may be writing: SQLite copies it as one read
  // transaction, write-ahead log included, without taking a write lock on it.
  const v1 = new Database(source, { readonly: true })
  const counts = (() => {
    try {
      const tables = new Set(
        v1
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      )
      if (!tables.has("session") || !tables.has("message"))
        throw new Error(`${source} is not an OpenCode 1.x database: it has no session and message tables`)
      const count = (table: string) => v1.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0
      const found = { sessions: count("session"), messages: count("message") }
      v1.query("VACUUM INTO ?").run(temp)
      return found
    } finally {
      v1.close()
    }
  })()
  const backup = existsSync(input.target) ? `${input.target}.bak-${stamp}` : undefined
  if (backup) moveDatabase(input.target, backup)
  renameSync(temp, input.target)
  return { source, target: input.target, ...counts, ...(backup ? { backup } : {}) }
}

/**
 * Undoes the last import: FlupCode's 2.x database goes back to what it was before (or to nothing, if
 * there was none). The database being replaced is moved aside, not deleted. Only while no 2.x engine
 * has it open.
 */
export function rollbackV1Import(input: { target: string; now?: () => number }) {
  const backup = backupsOf(input.target).at(-1)
  const aside = `${input.target}.rolled-back-${(input.now ?? Date.now)()}`
  if (existsSync(input.target)) moveDatabase(input.target, aside)
  if (backup) moveDatabase(backup, input.target)
  return { target: input.target, aside, ...(backup ? { restored: backup } : {}) }
}

/**
 * The memories a running 1.x engine keeps, copied into the 2.x engine's memory plugin (V2-32). Read
 * over 1.x's `/api/memory`, never from its database file: the route is the store's own answer, with
 * its scopes resolved. A memory 2.x already has (same scope, title and content) is not added twice.
 */
export async function importV1Memories(input: {
  from: { url: string; authorization?: string }
  to: { url: string; authorization?: string }
  fetch?: typeof fetch
}) {
  const request = input.fetch ?? fetch
  const get = async (path: string) => {
    const response = await request(new URL(path, input.from.url), {
      headers: input.from.authorization ? { authorization: input.from.authorization } : {},
    })
    if (!response.ok) throw new Error(`GET ${path} on the 1.x engine answered ${response.status}`)
    return (await response.json()) as unknown
  }
  const rpc = async (method: string, body: object, directory?: string) => {
    // The 2.x client's own encoding of a location in the query.
    const query = directory ? `?${new URLSearchParams({ "location[directory]": directory })}` : ""
    const response = await request(new URL(`/api/rpc/flupcode.memory/${method}${query}`, input.to.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.to.authorization ? { authorization: input.to.authorization } : {}),
      },
      body: JSON.stringify({ input: body }),
    })
    if (!response.ok)
      throw new Error(
        `The 2.x engine's memory plugin answered ${response.status} to ${method}; is FlupCode's memory plugin installed?`,
      )
    return ((await response.json()) as { output: unknown }).output
  }

  // Global memories answer anywhere; a project's only where it lives, so every project 1.x knows is asked.
  const projects = ((await get("/project")) as Array<{ worktree?: string }>).flatMap((project) =>
    project.worktree && project.worktree !== "/" ? [project.worktree] : [],
  )
  const seen = new Map<string, V1Memory>()
  for (const directory of [undefined, ...projects])
    for (const status of STATUSES) {
      const query = new URLSearchParams({ status, limit: "1000" })
      if (directory) query.set("location[directory]", directory)
      const listed = (await get(`/api/memory?${query}`)) as { data?: V1Memory[] }
      for (const memory of listed.data ?? []) seen.set(memory.id, memory)
    }

  const existing = new Set<string>()
  const key = (memory: { scope: string; title: string; content: string }) =>
    `${memory.scope}\n${memory.title}\n${memory.content}`
  const imported = []
  for (const memory of seen.values()) {
    const directory = memory.scope === "project" ? memory.directory : undefined
    if (memory.scope === "project" && !directory) continue
    if (!existing.has(`${directory ?? ""}`)) {
      existing.add(`${directory ?? ""}`)
      for (const status of STATUSES) {
        const present = (await rpc("list", { status, limit: 1000 }, directory)) as Array<{
          scope: string
          title: string
          content: string
        }>
        for (const item of present ?? []) existing.add(key(item))
      }
    }
    if (existing.has(key(memory))) continue
    await rpc(
      "create",
      {
        scope: memory.scope,
        kind: memory.kind,
        title: memory.title,
        content: memory.content,
        tags: memory.tags,
        status: memory.status,
        confidence: memory.confidence,
        importance: memory.importance,
        source: "import",
        ...(memory.scope === "session" ? { sessionID: memory.scopeID } : {}),
        ...(memory.scope === "agent" ? { agent: memory.scopeID } : {}),
      },
      directory,
    )
    existing.add(key(memory))
    imported.push(memory.id)
  }
  return { found: seen.size, imported: imported.length }
}

/** Where a released 1.x engine keeps its database. */
export function openCodeV1Database(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "opencode.db")
}

type V1Memory = {
  id: string
  scope: "global" | "project" | "agent" | "session"
  scopeID: string
  kind: string
  title: string
  content: string
  tags: string[]
  status: string
  confidence: number
  importance: number
  directory?: string
}

/** Archived memories stay behind: they were put away on purpose. */
const STATUSES = ["active", "candidate", "stale"]

/** A database is its file plus SQLite's write-ahead log and shared memory, moved together. */
const SIDECARS = ["", "-wal", "-shm"]

function moveDatabase(from: string, to: string) {
  for (const suffix of SIDECARS) if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix)
}

function removeDatabase(path: string) {
  for (const suffix of SIDECARS) rmSync(path + suffix, { force: true })
}

function backupsOf(target: string) {
  const prefix = `${basename(target)}.bak-`
  if (!existsSync(dirname(target))) return []
  return readdirSync(dirname(target))
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map((name) => join(dirname(target), name))
}
