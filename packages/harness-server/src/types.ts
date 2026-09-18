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
 * How a run spends (H-30).
 *
 * Models are named by role — the agent a task runs as — because that is what a process says about
 * who does what; a task that names its own model still wins. The budget is checked between tasks,
 * and reaching it pauses the run rather than killing it, so a person can say "carry on".
 */
export type RunPolicy = {
  /** A model per role, as "provider/model". */
  models?: Record<string, string>
  /** The model a task is retried on after it fails. */
  fallback?: string
  /** Stop and ask before spending past these. */
  budget?: { tokens?: number; cost?: number }
}

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
  /**
   * Whether the model may run shell commands (H-47).
   *
   * On by default. A run that says `false` gets no shell at all: the engine hides the bash tool and
   * refuses every command, which is the only exact confinement it offers — there is no sandbox. It
   * is kept as `false` rather than `true`, because only the unusual answer is worth storing.
   */
  shell?: boolean
  /**
   * Context packs to give every task in this run (H-31).
   *
   * A pack is a named set of references; the runner turns the ones that are files into `file` parts
   * and the rest into a context block, so a run works from what previous ones learned without
   * replaying a transcript.
   */
  packs?: string[]
  /**
   * Give each writing task its own git worktree (H-29).
   *
   * Off by default: a worktree is a branch and a checkout, and a run that does not need one should
   * not leave either behind. When it is on, a task writes in its own tree and the primary checkout
   * is untouched until somebody merges.
   */
  worktrees?: boolean
  /** How this run spends (H-30): a model per role, a fallback, and a budget. */
  policy?: RunPolicy
  /** Why it is waiting: a person at a gate, or a budget that was reached. */
  paused?: "gate" | "budget"
  /** Somebody said to carry on past the budget, so it is not checked again. */
  budgetApproved?: boolean
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

export type TaskStatus = "queued" | "running" | "success" | "failed" | "stopped" | "skipped"

/**
 * When a task is allowed to run, said in terms of an earlier task's outcome (H-28).
 *
 * `{ task: verify, is: failed }` is "only when the check failed": the escape hatch that makes a
 * recovery step declarative instead of a special case in the runner. The named task is a dependency
 * whether or not `dependsOn` repeats it, because the condition cannot be answered until it is done.
 */
export type TaskCondition = {
  task: string
  is: Array<Exclude<TaskStatus, "queued" | "running">>
}

/**
 * One executable unit of a run.
 *
 * A task is not a message: it is a piece of work with its own agent, its own session and its own
 * result, which is what makes a run inspectable while it happens and resumable after a restart
 * (§6.2). It runs as a child of the run's session, so the engine keeps the lineage and the harness
 * does not have to invent one.
 *
 * `dependsOn` is what turns a run's tasks into a graph (H-28). A task with explicit `dependsOn` runs
 * once every named task has settled and one of them succeeded; a task with an explicit empty list is
 * a root, which is how `parallel: true` in a workflow is written down. Absent means the v1 rule still
 * holds — this task follows the one before it — so a workflow that says nothing runs in order.
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
  /**
   * The tasks this one waits for, by name (H-28).
   *
   * An explicit list replaces the v1 "after the one before it" rule; an explicit **empty** list makes
   * the task a root, which is how a workflow writes `parallel: true`. Names are resolved against the
   * run, so a retry that repeats a name keeps its dependents waiting for the newest attempt.
   */
  dependsOn?: string[]
  /** Run only if an earlier task ended a certain way; otherwise this task is skipped (H-28). */
  when?: TaskCondition
  /**
   * One task per element of the plan a named task produced (H-28).
   *
   * The named task is the dependency. This row is the fan-out marker: when the plan is ready it is
   * marked done and one task is added per step, each with `{{item}}` replaced. Its dependents wait
   * for all of them because they share this name.
   */
  foreach?: string
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
  /**
   * The tree this task ran in (H-29).
   *
   * The primary checkout normally, or the worktree the task was given. Kept per task because its
   * checkpoints, its diff and its findings all belong to that tree, not to the run's folder.
   */
  directory?: string
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
  /** Kept in front of the rest, and never swept, however old it gets (H-14). */
  pinned?: boolean
  /**
   * When this may be forgotten (H-14). Absent means never — retention is stated, not assumed, so
   * evidence is not deleted because a default said so.
   */
  expiresAt?: number
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
  | { type: "artifact.changed"; artifact: Artifact }
  | { type: "checkpoint.added"; checkpoint: Checkpoint }
  | { type: "checkpoint.removed"; checkpointID: string }
  | { type: "findings.added"; findings: Finding[] }
  | { type: "finding.changed"; finding: Finding }
  | { type: "session.changed"; prefs: SessionPrefs }
  | { type: "stash.added"; prompt: StashedPrompt }
  | { type: "stash.removed"; promptID: string }

/** A way back to how a folder looked (H-15). The commit lives in the reader's own repository. */
export type Checkpoint = {
  id: string
  directory: string
  sha: string
  title: string
  /**
   * What the step that produced this point concluded (H-15).
   *
   * The task's own answer, kept here so the point says what it was for without opening the run.
   * Capped: this is a marker, not a copy of the transcript.
   */
  summary?: string
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

/**
 * What a reader keeps about a session that is not the model's (H-18).
 *
 * Pins and tags are theirs, not the engine's, and they have to travel: the phone reads the same
 * harness server. They live here rather than in the engine's session `metadata` because the session
 * list this app reads does not carry that field back.
 */
export type SessionPrefs = {
  sessionID: string
  pinned: boolean
  tags: string[]
  updatedAt: number
}

/** A prompt set aside to send later (H-18). Kept on the server so it is there on any device. */
export type StashedPrompt = {
  id: string
  text: string
  createdAt: number
}

/**
 * A context pack (H-26): a named set of references — `@file`, `@artifact` — that can be pulled back
 * into a prompt without retyping them.
 *
 * Stored here and not in the browser because a pack is worth sharing between devices, and because
 * the point of the audit's "packs, not transcripts" is that this is the unit that travels.
 */
export type ContextPack = {
  id: string
  name: string
  refs: string[]
  /** The folder it belongs to; absent means it is available in every project. */
  directory?: string
  createdAt: number
}

/** A conversation kept on this server so it can be read at a link (H-35). */
export type SharedConversation = {
  id: string
  title: string
  markdown: string
  createdAt: number
}

/**
 * A note the harness keeps about a project (H-37): a decision, a convention, something learned.
 *
 * Not the engine's memory, which is per session and chosen by the model. This is the project's, the
 * readme a person adds to by hand, and it is handed to every turn so it does not have to be repeated.
 */
export type ProjectMemory = {
  id: string
  directory: string
  text: string
  createdAt: number
}

export type StoredEvent = { seq: number; createdAt: number; event: ServerEvent }/** Runs, whatever asked for them. */
export type RunRepository = {
  startRun(
    source: RunSource,
    now: number,
    directory?: string,
    options?: Pick<Run, "toolLimitMs" | "outside" | "packs" | "worktrees" | "policy">,
  ): Run
  /** Hold a run at a gate: not running, not finished, waiting for a person. */
  awaitRun(runID: string): void
  /** Let it through, and say whether there was anything to let through. */
  resumeRun(runID: string): boolean
  /** Why a run is waiting (H-30). */
  setPaused(runID: string, paused: "gate" | "budget"): void
  /** A person let it past the budget (H-30). */
  approveBudget(runID: string): void
  /** Put a finished run back to running so a manual retry can add a task to it (H-12). */
  reopenRun(runID: string): boolean
  /** Give a run the work it is made of, in the order it will be done. */
  addTasks(runID: string, inputs: TaskInput[]): Task[]
  listTasks(runID: string): Task[]
  getTask(taskID: string): Task | undefined
  startTask(taskID: string, now: number): Task | undefined
  attachTaskSession(taskID: string, sessionID: string): void
  /** The tree a task ran in (H-29). */
  attachTaskDirectory(taskID: string, directory: string): void
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
  /** Keep one in front of the rest, or let it fall back into the list (H-14). */
  setArtifactPinned(id: string, pinned: boolean): Artifact | undefined
  /** Set when it may be forgotten; `undefined` means never (H-14). */
  setArtifactRetention(id: string, expiresAt: number | undefined): Artifact | undefined
  /** Forget everything whose stated retention has passed. Pinned ones are never swept. */
  removeExpiredArtifacts(now?: number): number
  /** A run left behind by a server that stopped mid-flight is not running any more. */
  recoverRunning(now: number): void
  /** What a reader pinned or tagged (H-18). Only sessions with something kept are listed. */
  listSessionPrefs(): SessionPrefs[]
  getSessionPrefs(sessionID: string): SessionPrefs | undefined
  setSessionPinned(sessionID: string, pinned: boolean): SessionPrefs
  setSessionTags(sessionID: string, tags: string[]): SessionPrefs
  /** Prompts set aside, newest first (H-18). */
  listStash(): StashedPrompt[]
  addToStash(text: string, now?: number): StashedPrompt
  removeFromStash(id: string): boolean
  /** Context packs (H-26): reusable sets of references, global or for one folder. */
  listPacks(directory?: string): ContextPack[]
  savePack(input: { name: string; refs: string[]; directory?: string }): ContextPack
  removePack(id: string): boolean
  /** A conversation kept so a link can read it (H-35). */
  saveShare(input: { title: string; markdown: string }): SharedConversation
  getShare(id: string): SharedConversation | undefined
  /** A project's notes (H-37), oldest first. */
  listProjectMemory(directory: string): ProjectMemory[]
  addProjectMemory(input: { directory: string; text: string }): ProjectMemory
  removeProjectMemory(id: string): boolean
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
