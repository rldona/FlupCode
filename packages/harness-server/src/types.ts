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

export type TaskStatus = "queued" | "running" | "success" | "failed" | "stopped"

/**
 * One executable unit of a run.
 *
 * A task is not a message: it is a piece of work with its own agent, its own session and its own
 * result, which is what makes a run inspectable while it happens and resumable after a restart
 * (§6.2). It runs as a child of the run's session, so the engine keeps the lineage and the harness
 * does not have to invent one.
 *
 * `dependsOn` is absent on purpose: v1 runs tasks in order, and the audit puts the DAG in H-28. An
 * order is a dependency list everyone already understands, and it is the one thing a sequential
 * runner can honour without pretending to more.
 */
export type TaskInput = {
  name: string
  prompt: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

export type Task = TaskInput & {
  id: string
  runID: string
  /** Where it sits in the run's order, from 0. */
  position: number
  status: TaskStatus
  sessionID?: string
  startedAt?: number
  finishedAt?: number
  error?: string
  /** What the task answered, kept so a later task can be handed it without replaying a transcript. */
  output?: string
  tokens?: number
  cost?: number
}

/**
 * What the server publishes as it changes. Persisted with a sequence number so a client that was
 * away can ask for what it missed instead of polling — which is what the browser does today, every
 * five seconds, because there was no stream to subscribe to.
 */
export type ServerEvent =
  | { type: "run.started"; run: Run }
  | { type: "run.changed"; run: Run }
  | { type: "run.removed"; runID: string }
  | { type: "task.changed"; task: Task }
  | { type: "routine.changed"; routine: Routine }
  | { type: "routine.removed"; routineID: string }

export type StoredEvent = { seq: number; createdAt: number; event: ServerEvent }

/** Runs, whatever asked for them. */
export type RunRepository = {
  startRun(source: RunSource, now: number): Run
  /** Give a run the work it is made of, in the order it will be done. */
  addTasks(runID: string, inputs: TaskInput[]): Task[]
  listTasks(runID: string): Task[]
  getTask(taskID: string): Task | undefined
  startTask(taskID: string, now: number): Task | undefined
  attachTaskSession(taskID: string, sessionID: string): void
  finishTask(
    taskID: string,
    status: Exclude<TaskStatus, "queued" | "running">,
    result?: { error?: string; output?: string; tokens?: number; cost?: number },
    now?: number,
  ): void
  getRun(runID: string): Run | undefined
  listRuns(source?: RunSource, limit?: number): Run[]
  /** Every run still going, however many there are: a stop-everything cannot work off one page. */
  listRunning(): Run[]
  attachSession(runID: string, sessionID: string): void
  finishRun(runID: string, status: Exclude<RunStatus, "running">, error?: string, now?: number): void
  /** Forget a run and the tasks it was made of. A running one is stopped first, by its scheduler. */
  removeRun(runID: string): boolean
  /** Forget every run that has finished, and say which ones went. Running ones are left alone. */
  removeFinishedRuns(): string[]
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
  lastSeq(): number
  listEvents(afterSeq: number, limit?: number): StoredEvent[]
}
