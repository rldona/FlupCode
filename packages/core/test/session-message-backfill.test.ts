import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { join } from "path"
import { fileURLToPath } from "url"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { tmpdir } from "./fixture/tmpdir"

const decode = Schema.decodeUnknownSync(SessionMessage.Message)
const script = fileURLToPath(new URL("../script/session-message-backfill.ts", import.meta.url))
const packageDir = fileURLToPath(new URL("..", import.meta.url))

const model = { id: "model", providerID: "provider" }
// Encoded storage shape: id and type live in their own columns, so the JSON blob omits them.
const legacyAssistant = {
  agent: "build",
  model,
  content: [{ type: "text", text: "legacy" }],
  time: { created: 0 },
}
const validUser = { text: "valid", time: { created: 0 } }
const legacyToolWithMetadata = {
  agent: "build",
  model,
  content: [
    {
      type: "tool",
      id: "call_metadata",
      name: "bash",
      time: { created: 0 },
      state: { status: "completed", input: {}, metadata: { answer: 42 }, content: [] },
    },
  ],
  time: { created: 0 },
}
const nonNormalizable = { agent: "build", model, content: "not an array", time: { created: 0 } }

type SeedRow = { id: string; type: string; data: unknown }

const defaultRows: SeedRow[] = [
  { id: "msg_legacy", type: "assistant", data: legacyAssistant },
  { id: "msg_valid", type: "user", data: validUser },
]

function seed(filename: string, rows: SeedRow[] = defaultRows) {
  const db = new Database(filename)
  db.run(`CREATE TABLE session_message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    type text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  )`)
  const insert = db.query(
    "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  )
  for (const row of rows) insert.run(row.id, "ses_backfill", row.type, 0, 0, JSON.stringify(row.data))
  db.close()
}

function readRow(filename: string, id: string) {
  const db = new Database(filename)
  const row = db.query("SELECT id, type, data FROM session_message WHERE id = ?").get(id) as
    | { id: string; type: string; data: string }
    | null
  db.close()
  return row
}

function runBackfillCapture(filename: string, apply: boolean) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, script, "--db", filename, ...(apply ? ["--apply"] : [])],
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(`backfill failed (${result.exitCode}): ${stderr || stdout}`)
  return { stdout, stderr }
}

const runBackfill = (filename: string, apply: boolean) => runBackfillCapture(filename, apply).stdout

const numberFrom = (stdout: string, key: string) => {
  const match = new RegExp(`${key}=(\\d+)`).exec(stdout)
  if (!match) throw new Error(`missing ${key} in: ${stdout}`)
  return Number(match[1])
}

const decodeStored = (row: { id: string; type: string; data: string }) =>
  decode({ ...JSON.parse(row.data), id: row.id, type: row.type })

describe("session-message-backfill", () => {
  test("dry-run reports normalizable rows without writing", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "backfill.sqlite")
    seed(filename)

    const stdout = runBackfill(filename, false)

    expect(stdout).toContain("dry-run")
    expect(numberFrom(stdout, "escaneadas")).toBe(2)
    expect(numberFrom(stdout, "válidas")).toBe(1)
    expect(numberFrom(stdout, "normalizables")).toBe(1)
    expect(numberFrom(stdout, "no-normalizables")).toBe(0)
    expect(numberFrom(stdout, "reescritas")).toBe(0)

    expect(readRow(filename, "msg_legacy")?.data).toBe(JSON.stringify(legacyAssistant))
    expect(readRow(filename, "msg_valid")?.data).toBe(JSON.stringify(validUser))
  })

  test("apply rewrites only the legacy row and a second pass rewrites nothing", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "backfill.sqlite")
    seed(filename)

    const first = runBackfill(filename, true)
    expect(first).toContain("apply")
    expect(numberFrom(first, "escaneadas")).toBe(2)
    expect(numberFrom(first, "válidas")).toBe(1)
    expect(numberFrom(first, "normalizables")).toBe(1)
    expect(numberFrom(first, "reescritas")).toBe(1)
    expect(numberFrom(first, "no-normalizables")).toBe(0)

    const validRow = readRow(filename, "msg_valid")
    if (!validRow) throw new Error("valid row missing")
    expect(validRow.data).toBe(JSON.stringify(validUser))
    expect(() => decodeStored(validRow)).not.toThrow()

    const legacyRow = readRow(filename, "msg_legacy")
    if (!legacyRow) throw new Error("legacy row missing")
    expect(legacyRow.data).not.toBe(JSON.stringify(legacyAssistant))
    const decoded = decodeStored(legacyRow)
    if (decoded.type !== "assistant") throw new Error("expected assistant")
    expect(decoded.content[0]).toMatchObject({ type: "text", id: "compat_msg_legacy_0" })

    const afterFirst = legacyRow.data
    const second = runBackfill(filename, true)
    expect(numberFrom(second, "válidas")).toBe(2)
    expect(numberFrom(second, "normalizables")).toBe(0)
    expect(numberFrom(second, "reescritas")).toBe(0)
    expect(numberFrom(second, "no-normalizables")).toBe(0)
    expect(readRow(filename, "msg_legacy")?.data).toBe(afterFirst)
  })

  test("counts an unrepairable row as no-normalizables and leaves it untouched", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "backfill.sqlite")
    seed(filename, [{ id: "msg_bad", type: "assistant", data: nonNormalizable }])

    const stdout = runBackfill(filename, true)

    expect(stdout).toContain("apply")
    expect(numberFrom(stdout, "escaneadas")).toBe(1)
    expect(numberFrom(stdout, "válidas")).toBe(0)
    expect(numberFrom(stdout, "normalizables")).toBe(0)
    expect(numberFrom(stdout, "reescritas")).toBe(0)
    expect(numberFrom(stdout, "no-normalizables")).toBe(1)
    expect(readRow(filename, "msg_bad")?.data).toBe(JSON.stringify(nonNormalizable))
  })

  test("apply maps tool metadata into structured and a second pass rewrites nothing", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "backfill.sqlite")
    seed(filename, [{ id: "msg_tool_metadata", type: "assistant", data: legacyToolWithMetadata }])

    const first = runBackfill(filename, true)
    expect(numberFrom(first, "escaneadas")).toBe(1)
    expect(numberFrom(first, "válidas")).toBe(0)
    expect(numberFrom(first, "normalizables")).toBe(1)
    expect(numberFrom(first, "reescritas")).toBe(1)
    expect(numberFrom(first, "no-normalizables")).toBe(0)

    const row = readRow(filename, "msg_tool_metadata")
    if (!row) throw new Error("tool row missing")
    expect(row.data).not.toBe(JSON.stringify(legacyToolWithMetadata))
    const decoded = decodeStored(row)
    if (decoded.type !== "assistant") throw new Error("expected assistant")
    expect(decoded.content[0]).toMatchObject({
      type: "tool",
      id: "call_metadata",
      state: { status: "completed", structured: { answer: 42 } },
    })

    const afterFirst = row.data
    const second = runBackfill(filename, true)
    expect(numberFrom(second, "válidas")).toBe(1)
    expect(numberFrom(second, "normalizables")).toBe(0)
    expect(numberFrom(second, "reescritas")).toBe(0)
    expect(numberFrom(second, "no-normalizables")).toBe(0)
    expect(readRow(filename, "msg_tool_metadata")?.data).toBe(afterFirst)
  })

  test("warns about --apply on stderr and stays quiet on dry-run", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "backfill.sqlite")
    seed(filename)

    const dry = runBackfillCapture(filename, false)
    expect(dry.stderr).not.toContain("Aviso")

    const applied = runBackfillCapture(filename, true)
    expect(applied.stderr).toContain("Aviso")
    expect(applied.stderr).toContain("SQLITE_BUSY")
  })
})
