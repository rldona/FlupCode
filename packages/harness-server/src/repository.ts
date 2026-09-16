import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  Routine,
  RoutineCreateOptions,
  RoutineInput,
  RoutineRepository,
  RoutineRun,
  RoutineRunStatus,
} from "./types"

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
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS routine_runs_routine_id_started_at ON routine_runs(routine_id, started_at DESC);
CREATE TABLE IF NOT EXISTS routine_locks (
  routine_id TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
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
  routine_id: string
  session_id: string | null
  status: RoutineRunStatus
  started_at: number
  finished_at: number | null
  error: string | null
}

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

const decodeRoutine = (row: RoutineRow, runs: RoutineRun[]): Routine => ({
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

const decodeRun = (row: RunRow): RoutineRun => ({
  id: row.id,
  routineID: row.routine_id,
  sessionID: row.session_id ?? undefined,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? undefined,
  error: row.error ?? undefined,
})

export class SqliteRoutineRepository implements RoutineRepository {
  readonly db: Database

  constructor(path = process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec(schema)
  }

  list() {
    const rows = this.db.query("SELECT * FROM routines ORDER BY created_at DESC").all() as RoutineRow[]
    const runs = this.db.query("SELECT * FROM routine_runs ORDER BY started_at DESC").all() as RunRow[]
    const byRoutine = new Map<string, RoutineRun[]>()
    for (const run of runs) byRoutine.set(run.routine_id, [...(byRoutine.get(run.routine_id) ?? []), decodeRun(run)])
    return rows.map((row) => decodeRoutine(row, byRoutine.get(row.id) ?? []))
  }

  get(id: string) {
    const row = this.db.query("SELECT * FROM routines WHERE id = ?1").get(id) as RoutineRow | null
    if (!row) return undefined
    return decodeRoutine(row, this.listRuns(id))
  }

  create(input: RoutineInput, options: RoutineCreateOptions = {}) {
    const routine: Routine = {
      id: options.id ?? crypto.randomUUID(),
      ...input,
      enabled: options.enabled ?? true,
      createdAt: options.createdAt ?? Date.now(),
      lastRunAt: options.lastRunAt,
      runs: options.runs?.map((run) => ({ ...run, routineID: options.id ?? "" })) ?? [],
    }
    this.db
      .query(
        `INSERT INTO routines
          (id, name, description, prompt, schedule_json, project_directory, agent, model_json, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
      )
    if (routine.lastRunAt !== undefined) {
      this.db.query("UPDATE routines SET last_run_at = ?1 WHERE id = ?2").run(routine.lastRunAt, routine.id)
    }
    for (const run of routine.runs) {
      this.db
        .query(
          `INSERT OR IGNORE INTO routine_runs (id, routine_id, session_id, status, started_at, finished_at, error)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .run(
          run.id,
          routine.id,
          run.sessionID ?? null,
          run.status,
          run.startedAt,
          run.finishedAt ?? null,
          run.error ?? null,
        )
    }
    return routine
  }

  update(id: string, input: RoutineInput) {
    const result = this.db
      .query(
        `UPDATE routines
         SET name = ?1, description = ?2, prompt = ?3, schedule_json = ?4,
             project_directory = ?5, agent = ?6, model_json = ?7
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
    if (result.changes === 0) return undefined
    return this.get(id)
  }

  remove(id: string) {
    return this.db.query("DELETE FROM routines WHERE id = ?1").run(id).changes > 0
  }

  setEnabled(id: string, enabled: boolean) {
    this.db.query("UPDATE routines SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, id)
  }

  listRuns(routineID: string) {
    const rows = this.db
      .query("SELECT * FROM routine_runs WHERE routine_id = ?1 ORDER BY started_at DESC LIMIT 50")
      .all(routineID) as RunRow[]
    return rows.map(decodeRun)
  }

  acquire(routineID: string, owner: string, now: number, ttl: number) {
    const transaction = this.db.transaction(() => {
      this.db.query("DELETE FROM routine_locks WHERE routine_id = ?1 AND expires_at <= ?2").run(routineID, now)
      const result = this.db
        .query(
          `INSERT OR IGNORE INTO routine_locks (routine_id, owner, acquired_at, expires_at)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .run(routineID, owner, now, now + ttl)
      return result.changes > 0
    })
    return transaction()
  }

  release(routineID: string, owner: string) {
    this.db.query("DELETE FROM routine_locks WHERE routine_id = ?1 AND owner = ?2").run(routineID, owner)
  }

  renew(routineID: string, owner: string, now: number, ttl: number) {
    this.db
      .query("UPDATE routine_locks SET acquired_at = ?1, expires_at = ?2 WHERE routine_id = ?3 AND owner = ?4")
      .run(now, now + ttl, routineID, owner)
  }

  startRun(routineID: string, now: number) {
    const routine = this.get(routineID)
    if (!routine) return undefined
    const run: RoutineRun = { id: crypto.randomUUID(), routineID, status: "running", startedAt: now }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO routine_runs (id, routine_id, status, started_at)
           VALUES (?1, ?2, 'running', ?3)`,
        )
        .run(run.id, routineID, now)
      this.db.query("UPDATE routines SET last_run_at = ?1 WHERE id = ?2").run(now, routineID)
    })()
    return run
  }

  attachSession(runID: string, sessionID: string) {
    this.db.query("UPDATE routine_runs SET session_id = ?1 WHERE id = ?2").run(sessionID, runID)
  }

  finishRun(runID: string, status: Exclude<RoutineRunStatus, "running">, error?: string, now = Date.now()) {
    this.db
      .query("UPDATE routine_runs SET status = ?1, finished_at = ?2, error = ?3 WHERE id = ?4")
      .run(status, now, error ?? null, runID)
  }

  getRun(runID: string) {
    const row = this.db.query("SELECT * FROM routine_runs WHERE id = ?1").get(runID) as RunRow | null
    return row ? decodeRun(row) : undefined
  }

  recoverRunning(now: number) {
    this.db
      .query(
        `UPDATE routine_runs
         SET status = 'failed', finished_at = ?1, error = 'Harness server restarted while the run was active'
         WHERE status = 'running'`,
      )
      .run(now)
    this.db.query("DELETE FROM routine_locks").run()
  }

  close() {
    this.db.close()
  }
}

function defaultDatabasePath() {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "harness.sqlite")
}
