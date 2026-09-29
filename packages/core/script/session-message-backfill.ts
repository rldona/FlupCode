#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { parseArgs } from "util"
import { SessionMessage } from "../src/session/message"
import { SessionMessageCompat } from "../src/session/message-compat"

const BATCH = 500

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    apply: { type: "boolean", default: false },
  },
})

const CoreDatabase = await import("../src/database/database")
const filename = args.values.db ?? CoreDatabase.Database.path()
const apply = args.values.apply

if (apply) {
  console.error(
    "Aviso: --apply reescribe filas de session_message. Haz una copia de seguridad del fichero antes de continuar. " +
      "Si el proceso falla con SQLITE_BUSY, vuelve a ejecutarlo: es re-ejecutable y omite las filas ya reescritas.",
  )
}

const decodeOption = Schema.decodeUnknownOption(SessionMessage.Message)
const encode = Schema.encodeSync(SessionMessage.Message)
const parseJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const db = new Database(filename)
db.run("PRAGMA busy_timeout = 5000")

const select = db.query<{ id: string; type: string; data: string }, [string]>(
  `SELECT id, type, data FROM session_message WHERE id > ? ORDER BY id LIMIT ${BATCH}`,
)
const update = db.query("UPDATE session_message SET data = ? WHERE id = ?")
const flush = db.transaction((rows: ReadonlyArray<{ id: string; data: string }>) => {
  for (const row of rows) update.run(row.data, row.id)
})

const summary = { scanned: 0, valid: 0, rewritten: 0, invalid: 0 }
let cursor = ""

while (true) {
  const rows = select.all(cursor)
  if (rows.length === 0) break
  const updates: { id: string; data: string }[] = []
  for (const row of rows) {
    summary.scanned++
    const parsed = parseJson(row.data)
    if (Option.isNone(parsed) || !isRecord(parsed.value)) {
      summary.invalid++
      continue
    }
    const envelope = { ...parsed.value, id: row.id, type: row.type }
    if (Option.isSome(decodeOption(envelope))) {
      summary.valid++
      continue
    }
    const decoded = decodeOption(SessionMessageCompat.normalize(envelope))
    if (Option.isNone(decoded)) {
      summary.invalid++
      continue
    }
    summary.rewritten++
    const { id: _id, type: _type, ...data } = encode(decoded.value) as Record<string, unknown>
    updates.push({ id: row.id, data: JSON.stringify(data) })
  }
  if (apply && updates.length > 0) flush(updates)
  cursor = rows[rows.length - 1].id
  if (rows.length < BATCH) break
}

db.close()

console.log(
  `${apply ? "apply" : "dry-run"} (${filename}): escaneadas=${summary.scanned} válidas=${summary.valid} ` +
    `reescritas=${apply ? summary.rewritten : 0} normalizables=${summary.rewritten} no-normalizables=${summary.invalid}`,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
