import { Engine } from "./engine"
import { TaskRunner } from "./runner"
import { isDue } from "./schedule"
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
    const run = this.repository.startRun({ type: "manual" }, Date.now())
    this.repository.addTasks(run.id, input.tasks)
    // More than one task means a thread of its own: the run's session is what a person reads, and
    // the engine keeps each task's session under it. One task needs none — its own session is the
    // thread — and creating one anyway would leave an empty session in everybody's list.
    if (input.tasks.length > 1) {
      const root = await this.engine
        .createSession({ directory: input.directory, title: input.tasks[0]?.name ?? "Run" })
        .catch(() => undefined)
      if (root) this.repository.attachSession(run.id, root.id)
    }
    const runner = new TaskRunner(this.repository, this.engine)
    void runner
      .execute(run, { directory: input.directory, stopped: () => this.stopping.has(run.id) })
      .then(
        () => this.finishRun(run.id, this.stopping.has(run.id) ? "stopped" : "success"),
        (cause: unknown) =>
          this.finishRun(run.id, "failed", cause instanceof Error ? cause.message : String(cause)),
      )
    return run
  }

  private finishRun(runID: string, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(runID, status, error)
    this.stopping.delete(runID)
  }

  async stopRun(runID: string) {
    const run = this.repository.getRun(runID)
    if (!run || run.status !== "running") return run
    this.stopping.add(runID)
    if (!run.sessionID) return run
    const routineID = run.source.type === "routine" ? run.source.routineID : undefined
    const directory = routineID ? this.repository.get(routineID)?.projectDirectory : undefined
    await this.engine.interrupt(run.sessionID, directory)
    return this.repository.getRun(runID)
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
      await runner.execute(run, {
        directory: routine.projectDirectory,
        stopped: () => this.stopping.has(run.id),
      })
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
    if (run.source.type === "routine") this.repository.release(routineLockKey(run.source.routineID), this.owner)
    this.stopping.delete(run.id)
  }
}
