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
    const routineID = run.source.type === "routine" ? run.source.routineID : undefined
    const directory = routineID ? this.repository.get(routineID)?.projectDirectory : undefined
    await this.interrupt(run.sessionID, directory)
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
      if (this.stopping.has(run.id)) await this.interrupt(session.id, routine.projectDirectory)
      const client = createOpencodeClient({ baseUrl: this.engineURL })
      await unwrap(client.session.update({ sessionID: session.id, title: routine.name }))
      // The legacy runtime, the same one every Code and Chat turn goes to since H-01. It is where
      // subagents, MCP, retries and titles live, and where a question or a permission a routine
      // raises can be answered from the app at all — the v2 registries answer empty for it. It is
      // asynchronous, so the turn is followed rather than awaited.
      await unwrap(
        client.session.promptAsync({
          sessionID: session.id,
          ...(routine.projectDirectory ? { directory: routine.projectDirectory } : {}),
          ...(routine.agent ? { agent: routine.agent } : {}),
          ...(routine.model
            ? {
                model: { providerID: routine.model.providerID, modelID: routine.model.id },
                ...(routine.model.variant ? { variant: routine.model.variant } : {}),
              }
            : {}),
          parts: [{ type: "text", text: routine.prompt }],
        }),
      )
      await this.waitForIdle(session.id, run.id, routine.projectDirectory)
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

  /**
   * Wait for the turn to end.
   *
   * Not with `session.wait`: this engine answers 503 for it, and a run whose work had finished was
   * being marked failed because of it — the prompt had run and the session held both messages.
   * Asking which sessions are active is what the app itself does, and it is answered by the same
   * runner this prompt went to.
   *
   * A turn that never leaves the active list is not left to hang: the wait gives up, and the run
   * ends as failed saying so, rather than holding the routine's lock for ever.
   */
  private async waitForIdle(sessionID: string, runID: string, directory?: string, timeoutMs = 30 * 60_000) {
    const client = createOpencodeClient({ baseUrl: this.engineURL })
    const deadline = Date.now() + timeoutMs
    // A turn is not busy before it starts, and "not busy yet" reads exactly like "already finished".
    // So the session is given a moment to appear busy first: without it, a turn slower to start than
    // the first check would be called a success before it had done anything. A turn that finishes
    // inside this window — measured at 0.6s against a fast model — never appears, and the wait below
    // ends on its first check.
    const settleUntil = Date.now() + 3000
    while (Date.now() < settleUntil) {
      if (this.stopping.has(runID)) return
      if (await this.isBusy(client, sessionID, directory)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    while (Date.now() < deadline) {
      if (this.stopping.has(runID)) return
      if (!(await this.isBusy(client, sessionID, directory))) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error("The routine was still running after 30 minutes")
  }

  /**
   * Whether the engine is still working on this session.
   *
   * A legacy turn never appears in `/api/session/active` — measured against a local engine — so the
   * folder's own status map answers for it. The v2 list is asked only when there is no folder to
   * ask, or for a run started before routines moved to the legacy runtime.
   */
  private async isBusy(client: ReturnType<typeof createOpencodeClient>, sessionID: string, directory?: string) {
    if (directory) {
      const status = (await unwrap(client.session.status({ directory })).catch(() => undefined)) as
        | Record<string, { type?: string } | undefined>
        | undefined
      if (status) {
        const state = status[sessionID]?.type
        return state === "busy" || state === "retry"
      }
    }
    const active = await unwrap(client.v2.session.active()).catch(() => undefined)
    const running = active?.data as Record<string, unknown> | undefined
    return running ? sessionID in running : false
  }

  /** Stop the turn where it runs: a legacy one is aborted per folder, not interrupted by id. */
  private async interrupt(sessionID: string, directory?: string) {
    const client = createOpencodeClient({ baseUrl: this.engineURL })
    if (directory) {
      const aborted = await unwrap(client.session.abort({ sessionID, directory })).then(
        () => true,
        () => false,
      )
      if (aborted) return
    }
    await unwrap(client.v2.session.interrupt({ sessionID })).catch(() => undefined)
  }

  private finish(run: Run, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(run.id, status, error)
    if (run.source.type === "routine") this.repository.release(routineLockKey(run.source.routineID), this.owner)
    this.stopping.delete(run.id)
  }
}
