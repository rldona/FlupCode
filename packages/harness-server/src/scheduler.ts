import { Engine } from "./engine"
import { TaskRunner } from "./runner"
import { isDue } from "./schedule"
import { findWorkflow, tasksFor } from "./workflow"
import type { Run, RunSource, TaskInput } from "./types"
import { routineLockKey, type SqliteRoutineRepository } from "./repository"

type Result<T> = { data?: T; error?: unknown }

type SchedulerOptions = {
  repository: SqliteRoutineRepository
  engineURL: string
  intervalMs?: number
  lockTtlMs?: number
}

const unwrap = async <T>(call: Promise<Result<T>>) => {
  const result = await call
  if (result.error !== undefined && result.error !== null) {
    const error = result.error as { message?: string }
    throw new Error(error.message ?? "Engine request failed")
  }
  if (result.data === undefined) throw new Error("Engine returned no data")
  return result.data
}

export class UnknownWorkflowError extends Error {
  constructor(name: string) {
    super(`No workflow called ${name}`)
    this.name = "UnknownWorkflowError"
  }
}

export class MissingInputsError extends Error {
  constructor(readonly missing: string[]) {
    super(`This workflow needs ${missing.join(", ")}`)
    this.name = "MissingInputsError"
  }
}

export class RoutineBusyError extends Error {
  constructor() {
    super("Routine is already running")
    this.name = "RoutineBusyError"
  }
}

export class RoutineScheduler {
  readonly repository: SqliteRoutineRepository
  readonly engineURL: string
  readonly engine: Engine
  readonly intervalMs: number
  readonly lockTtlMs: number
  private readonly owner = crypto.randomUUID()
  private readonly stopping = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(options: SchedulerOptions) {
    this.repository = options.repository
    this.engineURL = options.engineURL.replace(/\/$/, "")
    this.engine = new Engine(this.engineURL)
    this.intervalMs = options.intervalMs ?? 30_000
    this.lockTtlMs = options.lockTtlMs ?? 24 * 60 * 60 * 1000
  }

  start() {
    this.repository.recoverRunning(Date.now())
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async runNow(routineID: string) {
    const run = this.begin(routineID, Date.now())
    if (!run) throw new RoutineBusyError()
    void this.execute(run)
    return run
  }

  /**
   * Start a run of tasks that no routine asked for.
   *
   * The same path a routine takes, minus the schedule: a run, its tasks, and the runner. It is what
   * a workflow will use once H-21 can describe one, and what makes a multi-task run testable today.
   */
  async runTasks(input: { tasks: TaskInput[]; directory?: string }) {
    if (input.tasks.length === 0) throw new Error("A run needs at least one task")
    const run = this.repository.startRun({ type: "manual" }, Date.now(), input.directory)
    this.repository.addTasks(run.id, input.tasks)
    // More than one task means a thread of its own: the run's session is what a person reads, and
    // the engine keeps each task's session under it. One task needs none — its own session is the
    // thread — and creating one anyway would leave an empty session in everybody's list.
    if (input.tasks.length > 1) {
      // Named after the work, not after its first task: titling it `tasks[0].name` put two sessions
      // with the same name in the list and no way to tell the run's thread from the task's.
      const title = input.tasks.map((task) => task.name).join(" → ")
      const root = await this.engine
        .createSession({
          directory: input.directory,
          title: title.length > 80 ? `${title.slice(0, 77)}…` : title,
        })
        .catch(() => undefined)
      if (root) this.repository.attachSession(run.id, root.id)
    }
    void this.drive(run.id, input.directory)
    return run
  }

  /**
   * Start a run from a workflow (H-21).
   *
   * The workflow decides what the tasks are; everything after that is the path a manual run already
   * takes. That is the point of writing processes down as files: the supervisor, the stream,
   * verification and the retry do not learn anything new.
   */
  async runWorkflow(input: { name: string; inputs?: Record<string, string>; directory?: string }) {
    const workflow = await findWorkflow(input.name, input.directory)
    if (!workflow) throw new UnknownWorkflowError(input.name)
    const missing = workflow.inputs.filter((name) => !input.inputs?.[name]?.trim())
    if (missing.length > 0) throw new MissingInputsError(missing)
    return this.runTasks({ tasks: tasksFor(workflow, input.inputs ?? {}), directory: input.directory })
  }

  /**
   * Runs what a run has queued, and records how it ended.
   *
   * Separate from starting it because it is entered twice: once when the run begins, and again when
   * somebody lets it through a gate.
   */
  private async drive(runID: string, directory?: string) {
    const run = this.repository.getRun(runID)
    if (!run) return
    const runner = new TaskRunner(this.repository, this.engine)
    try {
      const outcome = await runner.execute(run, { directory, stopped: () => this.stopping.has(runID) })
      if (outcome === "paused" && !this.stopping.has(runID)) return this.repository.awaitRun(runID)
      this.finishRun(runID, this.stopping.has(runID) ? "stopped" : "success")
    } catch (cause) {
      this.finishRun(runID, "failed", cause instanceof Error ? cause.message : String(cause))
    }
  }

  /**
   * Let a run through the gate it stopped at.
   *
   * The directory comes from the run itself, which is why it is stored: a run picked up minutes
   * later has nobody left holding the arguments it was started with.
   */
  approve(runID: string) {
    const run = this.repository.getRun(runID)
    if (!run || run.status !== "awaiting") return undefined
    if (!this.repository.resumeRun(runID)) return undefined
    void this.drive(runID, run.directory)
    return this.repository.getRun(runID)
  }

  private finishRun(runID: string, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(runID, status, error)
    this.writeReport(runID, status, error)
    this.stopping.delete(runID)
  }

  /**
   * What the run did, kept where it can be read later (H-14).
   *
   * §6.3 wanted this as a message in the run's own session, which the engine cannot do without
   * paying for a turn to restate what the harness already knows exactly. As an artifact it costs
   * nothing and outlives the twenty runs the supervisor shows.
   */
  private writeReport(runID: string, status: string, error?: string) {
    const run = this.repository.getRun(runID)
    if (!run) return
    const tasks = this.repository.listTasks(runID)
    if (tasks.length === 0) return
    const tokens = tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0)
    const cost = tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0)
    const seconds = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)
    const lines = [
      `Run ${status} in ${seconds}s`,
      ...(error ? ["", error] : []),
      "",
      ...tasks.map((task) => {
        const marks = [task.status, task.agent, task.tokens ? `${task.tokens} tokens` : undefined]
        return `- ${task.name}${task.attempt > 1 ? ` (attempt ${task.attempt})` : ""} — ${marks.filter(Boolean).join(", ")}`
      }),
      "",
      `${tasks.length} tasks, ${tokens} tokens, $${cost.toFixed(4)}`,
    ]
    this.repository.addArtifact({
      kind: "report",
      title: `Run ${status}`,
      producer: "harness",
      content: lines.join("\n"),
      directory: run.directory,
      runID,
      sessionID: run.sessionID,
    })
  }

  async stopRun(runID: string) {
    const run = this.repository.getRun(runID)
    if (!run || (run.status !== "running" && run.status !== "awaiting")) return run
    this.stopping.add(runID)
    // A run held at a gate has nobody driving it, so nothing would ever read the flag and finish it.
    // Stopping is also how a gate is refused: the answer to "let this through?" can be no.
    if (run.status === "awaiting") {
      this.finishRun(runID, "stopped", "Stopped at the gate")
      return this.repository.getRun(runID)
    }
    if (!run.sessionID) return run
    const routineID = run.source.type === "routine" ? run.source.routineID : undefined
    const directory = routineID ? this.repository.get(routineID)?.projectDirectory : undefined
    await this.engine.interrupt(run.sessionID, directory)
    return this.repository.getRun(runID)
  }

  /**
   * Stop everything that is going.
   *
   * One run failing to be interrupted must not leave the rest running, so each is asked on its own
   * and the count returned is what was asked, not what the engine managed.
   */
  async stopAll() {
    const running = this.repository.listRunning()
    await Promise.all(running.map((run) => this.stopRun(run.id).catch(() => undefined)))
    return running.length
  }

  private async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const routine = this.repository.list().find((entry) => isDue(entry, now))
      if (routine) {
        const run = this.begin(routine.id, now)
        if (run) void this.execute(run)
      }
    } finally {
      this.ticking = false
    }
  }

  private begin(routineID: string, now: number) {
    const key = routineLockKey(routineID)
    if (!this.repository.acquire(key, this.owner, now, this.lockTtlMs)) return undefined
    const source: RunSource = { type: "routine", routineID }
    const routine = this.repository.get(routineID)
    if (!routine) {
      this.repository.release(key, this.owner)
      return undefined
    }
    const run = this.repository.startRun(source, now)
    // A routine's execution is a run of a single task. Nothing about it is special: it is the same
    // shape a workflow of many will have, which is the point of H-11.
    this.repository.addTasks(run.id, [
      { name: routine.name, prompt: routine.prompt, agent: routine.agent, model: routine.model },
    ])
    return run
  }

  private async execute(run: Run) {
    // This scheduler only ever starts runs it sourced from a routine; anything else is not its work.
    const routineID = run.source.type === "routine" ? run.source.routineID : undefined
    const routine = routineID ? this.repository.get(routineID) : undefined
    if (!routine) return this.finish(run, "failed", "Routine was deleted")
    const heartbeat = setInterval(
      () => this.repository.renew(routineLockKey(routine.id), this.owner, Date.now(), this.lockTtlMs),
      Math.max(1000, Math.floor(this.lockTtlMs / 3)),
    )
    try {
      const runner = new TaskRunner(this.repository, this.engine)
      const outcome = await runner.execute(run, {
        directory: routine.projectDirectory,
        stopped: () => this.stopping.has(run.id),
      })
      // A routine's run is one task with no gate, so this cannot happen today — but saying "success"
      // for a run that stopped halfway is the kind of lie that survives a refactor.
      if (outcome === "paused" && !this.stopping.has(run.id)) {
        this.repository.awaitRun(run.id)
        this.repository.release(routineLockKey(routine.id), this.owner)
        return
      }
      // A run of one task has no thread of its own, so the session the reader wants is the task's.
      const [task] = this.repository.listTasks(run.id)
      if (task?.sessionID && !run.sessionID) this.repository.attachSession(run.id, task.sessionID)
      this.finish(run, this.stopping.has(run.id) ? "stopped" : "success", this.stopping.has(run.id) ? "Routine stopped" : undefined)
    } catch (cause) {
      this.finish(
        run,
        this.stopping.has(run.id) ? "stopped" : "failed",
        this.stopping.has(run.id) ? "Routine stopped" : cause instanceof Error ? cause.message : String(cause),
      )
    } finally {
      clearInterval(heartbeat)
    }
  }

  private finish(run: Run, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(run.id, status, error)
    this.writeReport(run.id, status, error)
    if (run.source.type === "routine") this.repository.release(routineLockKey(run.source.routineID), this.owner)
    this.stopping.delete(run.id)
  }
}
