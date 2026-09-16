import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { isDue } from "./schedule"
import type { Routine, Run, RunSource } from "./types"
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
  readonly intervalMs: number
  readonly lockTtlMs: number
  private readonly owner = crypto.randomUUID()
  private readonly stopping = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(options: SchedulerOptions) {
    this.repository = options.repository
    this.engineURL = options.engineURL.replace(/\/$/, "")
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

  async stopRun(runID: string) {
    const run = this.repository.getRun(runID)
    if (!run || run.status !== "running") return run
    this.stopping.add(runID)
    if (!run.sessionID) return run
    const client = createOpencodeClient({ baseUrl: this.engineURL })
    await unwrap(client.v2.session.interrupt({ sessionID: run.sessionID }))
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
    return this.repository.startRun(source, now)
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
      const session = await this.createSession(routine)
      this.repository.attachSession(run.id, session.id)
      if (this.stopping.has(run.id)) await this.interrupt(session.id)
      const client = createOpencodeClient({ baseUrl: this.engineURL })
      await unwrap(client.session.update({ sessionID: session.id, title: routine.name }))
      await unwrap(
        client.v2.session.prompt({
          sessionID: session.id,
          prompt: { text: routine.prompt },
        }),
      )
      await unwrap(client.v2.session.wait({ sessionID: session.id }))
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

  private async createSession(routine: Routine) {
    const result = await unwrap(
      createOpencodeClient({ baseUrl: this.engineURL }).v2.session.create({
        ...(routine.agent ? { agent: routine.agent } : {}),
        ...(routine.model ? { model: routine.model } : {}),
        ...(routine.projectDirectory ? { location: { directory: routine.projectDirectory } } : {}),
      }),
    )
    return result.data
  }

  private async interrupt(sessionID: string) {
    await unwrap(createOpencodeClient({ baseUrl: this.engineURL }).v2.session.interrupt({ sessionID }))
  }

  private finish(run: Run, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(run.id, status, error)
    if (run.source.type === "routine") this.repository.release(routineLockKey(run.source.routineID), this.owner)
    this.stopping.delete(run.id)
  }
}
