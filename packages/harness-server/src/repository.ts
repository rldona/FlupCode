import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  Routine,
  RoutineCreateOptions,
  RoutineInput,
  RoutineRepository,
  Run,
  RunSource,
  RunStatus,
  ServerEvent,
  StoredEvent,
} from "./types"

/**
 * Runs are their own table, keyed by what asked for them rather than owned by a routine, and there
 * is a log of what changed so a client can catch up instead of polling. The lock is keyed by a
 * string for the same reason: what must not run twice at once is a run, and a routine is only one
 * thing that starts one.
 */
const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  project_directory TEXT,
  agent TEXT,
  model_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_source_started_at ON runs(source_type, source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
`

/**
 * The first shape of this server stored runs as `routine_runs`, owned by a routine. Anyone who ran
 * that build has rows worth keeping, so they are carried over once and the old tables dropped.
 */
const migration = `
INSERT OR IGNORE INTO runs (id, source_type, source_id, session_id, status, started_at, finished_at, error)
  SELECT id, 'routine', routine_id, session_id, status, started_at, finished_at, error FROM routine_runs;
DROP TABLE routine_runs;
DROP TABLE routine_locks;
`

type RoutineRow = {
  id: string
  name: string
  description: string
  prompt: string
  schedule_json: string
  project_directory: string | null
  agent: string | null
  model_json: string | null
  enabled: number
  created_at: number
  last_run_at: number | null
}

type RunRow = {
  id: string
  source_type: string
  source_id: string | null
  session_id: string | null
  status: RunStatus
  started_at: number
  finished_at: number | null
  error: string | null
}

type EventRow = { seq: number; created_at: number; payload_json: string }

const decodeModel = (value: string | null) => {
  if (!value) return undefined
  try {
    const model = JSON.parse(value) as { providerID?: unknown; id?: unknown; variant?: unknown }
    if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
    return {
      providerID: model.providerID,
      id: model.id,
      variant: typeof model.variant === "string" ? model.variant : undefined,
    }
  } catch {
    return undefined
  }
}

const decodeRoutine = (row: RoutineRow, runs: Run[]): Routine => ({
  id: row.id,
  name: row.name,
  description: row.description,
  prompt: row.prompt,
  schedule: JSON.parse(row.schedule_json),
  projectDirectory: row.project_directory ?? undefined,
  agent: row.agent ?? undefined,
  model: decodeModel(row.model_json),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastRunAt: row.last_run_at ?? undefined,
  runs,
})

const decodeSource = (row: RunRow): RunSource =>
  row.source_type === "routine" && row.source_id ? { type: "routine", routineID: row.source_id } : { type: "manual" }

const decodeRun = (row: RunRow): Run => ({
  id: row.id,
  source: decodeSource(row),
  sessionID: row.session_id ?? undefined,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? undefined,
  error: row.error ?? undefined,
})

const sourceKey = (source: RunSource) => (source.type === "routine" ? source.routineID : null)

export class SqliteRoutineRepository implements RoutineRepository {
  readonly db: Database
  private readonly listeners = new Set<(entry: StoredEvent) => void>()

  constructor(path = process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec(schema)
    const legacy = this.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routine_runs'")
      .get() as { name?: string } | null
    if (legacy?.name) this.db.exec(migration)
  }

  // ---- routines -------------------------------------------------------------------------------

  list() {
    const rows = this.db.query("SELECT * FROM routines ORDER BY created_at DESC").all() as RoutineRow[]
    const runs = this.db
      .query("SELECT * FROM runs WHERE source_type = 'routine' ORDER BY started_at DESC")
      .all() as RunRow[]
    const byRoutine = new Map<string, Run[]>()
    for (const run of runs) {
      const key = run.source_id ?? ""
      byRoutine.set(key, [...(byRoutine.get(key) ?? []), decodeRun(run)])
    }
    return rows.map((row) => decodeRoutine(row, byRoutine.get(row.id) ?? []))
  }

  get(id: string) {
    const row = this.db.query("SELECT * FROM routines WHERE id = ?1").get(id) as RoutineRow | null
    if (!row) return undefined
    return decodeRoutine(row, this.listRuns({ type: "routine", routineID: id }))
  }

  create(input: RoutineInput, options: RoutineCreateOptions = {}) {
    const id = options.id ?? crypto.randomUUID()
    const source: RunSource = { type: "routine", routineID: id }
    const routine: Routine = {
      id,
      ...input,
      enabled: options.enabled ?? true,
      createdAt: options.createdAt ?? Date.now(),
      lastRunAt: options.lastRunAt,
      runs: options.runs?.map((run) => ({ ...run, source })) ?? [],
    }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO routines
            (id, name, description, prompt, schedule_json, project_directory, agent, model_json, enabled, created_at, last_run_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .run(
          routine.id,
          routine.name,
          routine.description,
          routine.prompt,
          JSON.stringify(routine.schedule),
          routine.projectDirectory ?? null,
          routine.agent ?? null,
          routine.model ? JSON.stringify(routine.model) : null,
          routine.enabled ? 1 : 0,
          routine.createdAt,
          routine.lastRunAt ?? null,
        )
      for (const run of routine.runs) this.insertRun(run)
    })()
    this.append({ type: "routine.changed", routine })
    return routine
  }

  update(id: string, input: RoutineInput) {
    if (!this.get(id)) return undefined
    this.db
      .query(
        `UPDATE routines
         SET name = ?1, description = ?2, prompt = ?3, schedule_json = ?4, project_directory = ?5, agent = ?6, model_json = ?7
         WHERE id = ?8`,
      )
      .run(
        input.name,
        input.description,
        input.prompt,
        JSON.stringify(input.schedule),
        input.projectDirectory ?? null,
        input.agent ?? null,
        input.model ? JSON.stringify(input.model) : null,
        id,
      )
    const routine = this.get(id)
    if (routine) this.append({ type: "routine.changed", routine })
    return routine
  }

  remove(id: string) {
    const removed = this.db.transaction(() => {
      // Runs are keyed by their source rather than owned by a foreign key, so they go explicitly.
      this.db.query("DELETE FROM runs WHERE source_type = 'routine' AND source_id = ?1").run(id)
      this.db.query("DELETE FROM locks WHERE key = ?1").run(routineLockKey(id))
      return this.db.query("DELETE FROM routines WHERE id = ?1").run(id).changes > 0
    })()
    if (removed) this.append({ type: "routine.removed", routineID: id })
    return removed
  }

  setEnabled(id: string, enabled: boolean) {
    this.db.query("UPDATE routines SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, id)
    const routine = this.get(id)
    if (routine) this.append({ type: "routine.changed", routine })
  }

  markRun(routineID: string, now: number) {
    this.db.query("UPDATE routines SET last_run_at = ?1 WHERE id = ?2").run(now, routineID)
  }

  // ---- runs -----------------------------------------------------------------------------------

  private insertRun(run: Run) {
    this.db
      .query(
        `INSERT OR IGNORE INTO runs (id, source_type, source_id, session_id, status, started_at, finished_at, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        run.id,
        run.source.type,
        sourceKey(run.source),
        run.sessionID ?? null,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        run.error ?? null,
      )
  }

  startRun(source: RunSource, now: number) {
    const run: Run = { id: crypto.randomUUID(), source, status: "running", startedAt: now }
    this.db.transaction(() => {
      this.insertRun(run)
      if (source.type === "routine") this.markRun(source.routineID, now)
    })()
    this.append({ type: "run.started", run })
    return run
  }

  getRun(runID: string) {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?1").get(runID) as RunRow | null
    return row ? decodeRun(row) : undefined
  }

  listRuns(source?: RunSource, limit = 50) {
    const rows = source
      ? (this.db
          .query("SELECT * FROM runs WHERE source_type = ?1 AND source_id IS ?2 ORDER BY started_at DESC LIMIT ?3")
          .all(source.type, sourceKey(source), limit) as RunRow[])
      : (this.db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?1").all(limit) as RunRow[])
    return rows.map(decodeRun)
  }

  attachSession(runID: string, sessionID: string) {
    this.db.query("UPDATE runs SET session_id = ?1 WHERE id = ?2").run(sessionID, runID)
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  finishRun(runID: string, status: Exclude<RunStatus, "running">, error?: string, now = Date.now()) {
    this.db
      .query("UPDATE runs SET status = ?1, finished_at = ?2, error = ?3 WHERE id = ?4")
      .run(status, now, error ?? null, runID)
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  recoverRunning(now: number) {
    this.db
      .query(
        `UPDATE runs
         SET status = 'failed', finished_at = ?1, error = 'Harness server restarted while the run was active'
         WHERE status = 'running'`,
      )
      .run(now)
    this.db.query("DELETE FROM locks").run()
  }

  // ---- locks ----------------------------------------------------------------------------------

  acquire(key: string, owner: string, now: number, ttl: number) {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM locks WHERE key = ?1 AND expires_at <= ?2").run(key, now)
      return (
        this.db
          .query("INSERT OR IGNORE INTO locks (key, owner, acquired_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
          .run(key, owner, now, now + ttl).changes > 0
      )
    })()
  }

  renew(key: string, owner: string, now: number, ttl: number) {
    this.db
      .query("UPDATE locks SET acquired_at = ?1, expires_at = ?2 WHERE key = ?3 AND owner = ?4")
      .run(now, now + ttl, key, owner)
  }

  release(key: string, owner: string) {
    this.db.query("DELETE FROM locks WHERE key = ?1 AND owner = ?2").run(key, owner)
  }

  // ---- events ---------------------------------------------------------------------------------

  /**
   * Everything that changes the store goes through here, which is what makes one subscription
   * enough: a listener sees the same sequence a reader would get from `listEvents`, so a client can
   * catch up from the database and then follow the stream without a gap in between.
   */
  subscribe(listener: (entry: StoredEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  append(event: ServerEvent, now = Date.now()): StoredEvent {
    const result = this.db
      .query("INSERT INTO events (created_at, payload_json) VALUES (?1, ?2)")
      .run(now, JSON.stringify(event))
    const entry: StoredEvent = { seq: Number(result.lastInsertRowid), createdAt: now, event }
    for (const listener of this.listeners) {
      // One slow listener must not take the writer down with it.
      try {
        listener(entry)
      } catch {
        this.listeners.delete(listener)
      }
    }
    return entry
  }

  listEvents(afterSeq: number, limit = 200): StoredEvent[] {
    const rows = this.db
      .query("SELECT * FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")
      .all(afterSeq, limit) as EventRow[]
    return rows.map((row) => ({ seq: row.seq, createdAt: row.created_at, event: JSON.parse(row.payload_json) }))
  }

  close() {
    this.db.close()
  }
}

/** One routine runs one at a time; the key says which. */
export const routineLockKey = (routineID: string) => `routine:${routineID}`

function defaultDatabasePath() {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "harness.sqlite")
}
