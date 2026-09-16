/**
 * The server's domain.
 *
 * A **run** is one execution the server owns: it starts, it may attach itself to an engine session,
 * and it ends. What asked for it is a **source** — a routine on its schedule, or a person pressing
 * the button. This is deliberately not `routine_run`: the audit's H-11 builds supervision,
 * checkpoints and workflows on top of runs, and a routine's execution is one of them (H-23, "cada
 * ejecución es un Run"). Modelling runs as something only routines have would have meant either a
 * second table for the same idea later, or a migration.
 *
 * Tasks — the unit H-11 splits a run into — are not here yet. They are designed with the things that
 * consume them, and an empty table now would only be a guess.
 */

export type RoutineSchedule =
  | { type: "manual"; timezone?: string }
  | { type: "hourly"; timezone?: string }
  | { type: "daily"; time: string; timezone?: string }
  | { type: "weekdays"; time: string; timezone?: string }
  | { type: "weekly"; day: number; time: string; timezone?: string }
  | { type: "interval"; intervalMinutes: number; timezone?: string }

/** What asked for a run. */
export type RunSource = { type: "routine"; routineID: string } | { type: "manual" }

export type RunStatus = "running" | "success" | "failed" | "stopped"

export type Run = {
  id: string
  source: RunSource
  sessionID?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string
}

export type RoutineInput = {
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
  projectDirectory?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

export type Routine = RoutineInput & {
  id: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  runs: Run[]
}

export type RoutineCreateOptions = {
  id?: string
  enabled?: boolean
  createdAt?: number
  lastRunAt?: number
  runs?: Array<Omit<Run, "source">>
}

/**
 * What the server publishes as it changes. Persisted with a sequence number so a client that was
 * away can ask for what it missed instead of polling — which is what the browser does today, every
 * five seconds, because there was no stream to subscribe to.
 */
export type ServerEvent =
  | { type: "run.started"; run: Run }
  | { type: "run.changed"; run: Run }
  | { type: "routine.changed"; routine: Routine }
  | { type: "routine.removed"; routineID: string }

export type StoredEvent = { seq: number; createdAt: number; event: ServerEvent }

/** Runs, whatever asked for them. */
export type RunRepository = {
  startRun(source: RunSource, now: number): Run
  getRun(runID: string): Run | undefined
  listRuns(source?: RunSource, limit?: number): Run[]
  attachSession(runID: string, sessionID: string): void
  finishRun(runID: string, status: Exclude<RunStatus, "running">, error?: string, now?: number): void
  /** A run left behind by a server that stopped mid-flight is not running any more. */
  recoverRunning(now: number): void
}

/** Routines, and the lock that keeps one from running twice at once. */
export type RoutineRepository = RunRepository & {
  list(): Routine[]
  get(id: string): Routine | undefined
  create(input: RoutineInput, options?: RoutineCreateOptions): Routine
  update(id: string, input: RoutineInput): Routine | undefined
  remove(id: string): boolean
  setEnabled(id: string, enabled: boolean): void
  markRun(routineID: string, now: number): void
  acquire(key: string, owner: string, now: number, ttl: number): boolean
  renew(key: string, owner: string, now: number, ttl: number): void
  release(key: string, owner: string): void
  append(event: ServerEvent, now?: number): StoredEvent
  listEvents(afterSeq: number, limit?: number): StoredEvent[]
}
