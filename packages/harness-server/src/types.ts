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

/**
 * `awaiting` is a run that stopped on purpose at a human gate (H-21) and is waiting to be let
 * through. It is not finished — it has no `finishedAt` — and it is not running either, which is why
 * it cannot be either of the four that existed.
 */
export type RunStatus = "running" | "awaiting" | "success" | "failed" | "stopped"

export type Run = {
  id: string
  source: RunSource
  /** Where the work happens. Kept so a run stopped at a gate can be picked up where it left off. */
  directory?: string
  sessionID?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string
  /**
   * How long one tool call may run before the task is stopped (H-47).
   *
   * Declared, never invented. The engine lets a model ask for a shell timeout of half an hour on
   * purpose, and a default that killed that would cut legitimate work — a test suite is allowed to
   * be slow. A run that wants a ceiling says so, and the reason it stopped is recorded.
   */
  toolLimitMs?: number
  /**
   * Let this run's tasks reach outside the project (H-47).
   *
   * Off by default: a task is confined to the project it runs in, which is the engine's own
   * `external_directory` boundary. Opening it is an explicit choice, the way H-04 asks — policies
   * only restrict, and a bypass is stated.
   */
  outside?: boolean
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
/**
 * What a task does.
 *
 * `agent` is a turn of the engine. `verify` is not: it runs the project's own commands and keeps
 * what they printed (H-22). Keeping them as kinds of the same thing is what lets a run be a mix —
 * do the work, then check it — without the supervisor, the stream or the store learning a new
 * shape.
 */
export type TaskKind = "agent" | "verify"

export type TaskInput = {
  name: string
  /** What the agent is asked. A verify task has nothing to say to a model, so it may be empty. */
  prompt: string
  kind?: TaskKind
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  /**
   * On a verify task: how many times the work before it may be attempted again if it fails (H-22).
   *
   * The budget travels with the task and is spent as it is used — the verify task a retry schedules
   * carries one less — so a run cannot loop, whatever goes wrong.
   */
  retries?: number
  /** Which attempt this is, from 1. A retry is a new task, not the same one run twice. */
  attempt?: number
  /** The task this one attempts again. */
  retryOf?: string
  /** `human` stops the run when this task is done, until somebody lets it through (H-21). */
  gate?: "human"
}

export type Task = TaskInput & {
  id: string
  runID: string
  kind: TaskKind
  attempt: number
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
 * What a run left behind (H-14).
 *
 * An index and a light store, not a CMS (§12.1). Most of what the harness produces is small text —
 * a verification report, a run's totals — so it is kept inline and capped; anything bigger is a
 * path to a file that already exists somewhere.
 *
 * The project is a directory rather than an id: that is what the harness actually knows about where
 * work happens, and inventing an id for it would mean keeping a second name for the same thing.
 */
export type ArtifactKind = "plan" | "report" | "verdict" | "diff" | "log" | "file" | "handoff"

export type ArtifactProducer = "agent" | "user" | "harness"

export type ArtifactInput = {
  kind: ArtifactKind
  title: string
  producer: ArtifactProducer
  /** The text itself, for anything small enough to keep. Capped; see `ARTIFACT_LIMIT`. */
  content?: string
  /** A file that already exists, for anything that is not. */
  path?: string
  mime?: string
  directory?: string
  runID?: string
  taskID?: string
  sessionID?: string
}

export type Artifact = ArtifactInput & {
  id: string
  mime: string
  createdAt: number
  /** What the content was before it was cut, in characters. Absent when nothing was cut. */
  bytes?: number
  truncated?: boolean
  /** Of the content, so the same report written twice is recognisable as the same thing. */
  hash?: string
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
  | { type: "artifact.created"; artifact: Artifact }
  | { type: "checkpoint.added"; checkpoint: Checkpoint }
  | { type: "checkpoint.removed"; checkpointID: string }
  | { type: "findings.added"; findings: Finding[] }
  | { type: "finding.changed"; finding: Finding }

/** A way back to how a folder looked (H-15). The commit lives in the reader's own repository. */
export type Checkpoint = {
  id: string
  directory: string
  sha: string
  title: string
  runID?: string
  taskID?: string
  createdAt: number
}

/** A review's point, anchored to a file and usually to a line (H-32). */
export type Finding = {
  id: string
  directory?: string
  runID?: string
  taskID?: string
  file: string
  line?: number
  severity: "high" | "medium" | "low"
  title: string
  detail?: string
  /**
   * Who said it: a model reviewing the work, or a check that actually failed.
   *
   * They are not the same claim and must not read as one. `review` is an opinion and can be wrong;
   * `check` is a command that exited non-zero, which is a fact. Older findings have neither, and
   * are shown as what they were then: reviews.
   */
  source?: "review" | "check"
  /** Set aside by a reader: kept, but out of the way. */
  resolved?: boolean
  createdAt: number
}

export type StoredEvent = { seq: number; createdAt: number; event: ServerEvent }

/** Runs, whatever asked for them. */
export type RunRepository = {
  startRun(source: RunSource, now: number, directory?: string, options?: Pick<Run, "toolLimitMs" | "outside">): Run
  /** Hold a run at a gate: not running, not finished, waiting for a person. */
  awaitRun(runID: string): void
  /** Let it through, and say whether there was anything to let through. */
  resumeRun(runID: string): boolean
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
  /** Keep what a run left behind (H-14). */
  addArtifact(input: ArtifactInput, now?: number): Artifact
  listArtifacts(filter?: { directory?: string; runID?: string; kind?: ArtifactKind }, limit?: number): Artifact[]
  getArtifact(id: string): Artifact | undefined
  removeArtifact(id: string): boolean
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
