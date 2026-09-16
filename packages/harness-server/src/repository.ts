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
  Task,
  TaskInput,
  TaskStatus,
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
  error TEXT,
  directory TEXT
);
CREATE INDEX IF NOT EXISTS runs_source_started_at ON runs(source_type, source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  attempt INTEGER NOT NULL DEFAULT 1,
  retries INTEGER,
  retry_of TEXT,
  gate TEXT,
  agent TEXT,
  model_json TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  output TEXT,
  tokens INTEGER,
  cost REAL
);
CREATE INDEX IF NOT EXISTS tasks_run_position ON tasks(run_id, position);
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
  directory: string | null
  session_id: string | null
  status: RunStatus
  started_at: number
  finished_at: number | null
  error: string | null
}

type TaskRow = {
  id: string
  run_id: string
  position: number
  name: string
  prompt: string
  kind: string | null
  attempt: number | null
  retries: number | null
  retry_of: string | null
  gate: string | null
  agent: string | null
  model_json: string | null
  session_id: string | null
  status: TaskStatus
  started_at: number | null
  finished_at: number | null
  error: string | null
  output: string | null
  tokens: number | null
  cost: number | null
}

const decodeTask = (row: TaskRow): Task => ({
  id: row.id,
  runID: row.run_id,
  position: row.position,
  name: row.name,
  prompt: row.prompt,
  kind: row.kind === "verify" ? "verify" : "agent",
  attempt: row.attempt ?? 1,
  retries: row.retries ?? undefined,
  retryOf: row.retry_of ?? undefined,
  gate: row.gate === "human" ? "human" : undefined,
  agent: row.agent ?? undefined,
  model: decodeModel(row.model_json),
  sessionID: row.session_id ?? undefined,
  status: row.status,
  startedAt: row.started_at ?? undefined,
  finishedAt: row.finished_at ?? undefined,
  error: row.error ?? undefined,
  output: row.output ?? undefined,
  tokens: row.tokens ?? undefined,
  cost: row.cost ?? undefined,
})

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
  directory: row.directory ?? undefined,
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
    // `CREATE TABLE IF NOT EXISTS` leaves a table that already exists alone, columns and all, so a
    // database written before this column existed never gets it. Every desktop app that has ever
    // run has one of those.
    this.addColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'agent'")
    this.addColumn("tasks", "attempt", "INTEGER NOT NULL DEFAULT 1")
    this.addColumn("tasks", "retries", "INTEGER")
    this.addColumn("tasks", "retry_of", "TEXT")
    this.addColumn("tasks", "gate", "TEXT")
    this.addColumn("runs", "directory", "TEXT")
  }

  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((entry) => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
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
      // Runs are keyed by their source rather than owned by a foreign key, so they go explicitly,
      // and the tasks they were made of go with them.
      this.db
        .query(
          `DELETE FROM tasks WHERE run_id IN
             (SELECT id FROM runs WHERE source_type = 'routine' AND source_id = ?1)`,
        )
        .run(id)
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
        `INSERT OR IGNORE INTO runs
           (id, source_type, source_id, session_id, status, started_at, finished_at, error, directory)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
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
        run.directory ?? null,
      )
  }

  startRun(source: RunSource, now: number, directory?: string) {
    const run: Run = { id: crypto.randomUUID(), source, status: "running", startedAt: now, directory }
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

  listRunning() {
    const rows = this.db
      .query("SELECT * FROM runs WHERE status IN ('running', 'awaiting') ORDER BY started_at DESC")
      .all() as RunRow[]
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

  removeRun(runID: string) {
    const removed = this.db.transaction(() => {
      this.db.query("DELETE FROM tasks WHERE run_id = ?1").run(runID)
      return this.db.query("DELETE FROM runs WHERE id = ?1").run(runID).changes > 0
    })()
    if (removed) this.append({ type: "run.removed", runID })
    return removed
  }

  awaitRun(runID: string) {
    this.db.query("UPDATE runs SET status = 'awaiting' WHERE id = ?1 AND status = 'running'").run(runID)
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  resumeRun(runID: string) {
    const changed =
      this.db.query("UPDATE runs SET status = 'running' WHERE id = ?1 AND status = 'awaiting'").run(runID).changes > 0
    if (!changed) return false
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
    return true
  }

  removeFinishedRuns() {
    const removed = this.db.transaction(() => {
      const going = "status IN ('running', 'awaiting')"
      const rows = this.db.query(`SELECT id FROM runs WHERE NOT ${going}`).all() as Array<{ id: string }>
      const ids = rows.map((row) => row.id)
      if (ids.length === 0) return ids
      this.db.query(`DELETE FROM tasks WHERE run_id IN (SELECT id FROM runs WHERE NOT ${going})`).run()
      this.db.query(`DELETE FROM runs WHERE NOT ${going}`).run()
      return ids
    })()
    // One event per run, the same one a single delete sends: a reader that already handles it needs
    // to learn nothing new to keep up with a clear-out.
    for (const id of removed) this.append({ type: "run.removed", runID: id })
    return removed
  }

  recoverRunning(now: number) {
    this.db
      .query(
        `UPDATE runs
         SET status = 'failed', finished_at = ?1, error = 'Harness server restarted while the run was active'
         WHERE status IN ('running', 'awaiting')`,
      )
      .run(now)
    this.db.query("DELETE FROM locks").run()
  }

  // ---- tasks ----------------------------------------------------------------------------------

  addTasks(runID: string, inputs: TaskInput[]) {
    const existing = this.db.query("SELECT COUNT(*) as n FROM tasks WHERE run_id = ?1").get(runID) as { n: number }
    const tasks = inputs.map((input, index) => ({
      ...input,
      kind: input.kind ?? ("agent" as const),
      attempt: input.attempt ?? 1,
      id: crypto.randomUUID(),
      runID,
      position: existing.n + index,
      status: "queued" as const,
    }))
    this.db.transaction(() => {
      for (const task of tasks) {
        this.db
          .query(
            `INSERT INTO tasks
               (id, run_id, position, name, prompt, kind, attempt, retries, retry_of, gate, agent, model_json, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'queued')`,
          )
          .run(
            task.id,
            runID,
            task.position,
            task.name,
            task.prompt,
            task.kind,
            task.attempt,
            task.retries ?? null,
            task.retryOf ?? null,
            task.gate ?? null,
            task.agent ?? null,
            task.model ? JSON.stringify(task.model) : null,
          )
      }
    })()
    for (const task of tasks) this.append({ type: "task.changed", task })
    return tasks
  }

  listTasks(runID: string) {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE run_id = ?1 ORDER BY position ASC")
      .all(runID) as TaskRow[]
    return rows.map(decodeTask)
  }

  getTask(taskID: string) {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?1").get(taskID) as TaskRow | null
    return row ? decodeTask(row) : undefined
  }

  startTask(taskID: string, now: number) {
    this.db.query("UPDATE tasks SET status = 'running', started_at = ?1 WHERE id = ?2").run(now, taskID)
    return this.publishTask(taskID)
  }

  attachTaskSession(taskID: string, sessionID: string) {
    this.db.query("UPDATE tasks SET session_id = ?1 WHERE id = ?2").run(sessionID, taskID)
    this.publishTask(taskID)
  }

  finishTask(
    taskID: string,
    status: Exclude<TaskStatus, "queued" | "running">,
    result: { error?: string; output?: string; tokens?: number; cost?: number } = {},
    now = Date.now(),
  ) {
    this.db
      .query(
        `UPDATE tasks SET status = ?1, finished_at = ?2, error = ?3, output = ?4, tokens = ?5, cost = ?6
         WHERE id = ?7`,
      )
      .run(
        status,
        now,
        result.error ?? null,
        result.output ?? null,
        result.tokens ?? null,
        result.cost ?? null,
        taskID,
      )
    this.publishTask(taskID)
  }

  private publishTask(taskID: string) {
    const task = this.getTask(taskID)
    if (task) this.append({ type: "task.changed", task })
    return task
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

  /** The sequence the log is at, so a client with nothing to catch up on starts at the end. */
  lastSeq(): number {
    const row = this.db.query("SELECT MAX(seq) as seq FROM events").get() as { seq: number | null } | null
    return row?.seq ?? 0
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
