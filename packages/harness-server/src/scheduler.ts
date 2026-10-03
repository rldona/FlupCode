import { createHash } from "node:crypto"
import { Engine } from "./engine"
import type { PreviewCapture } from "./browser-preview"
import { parseModelKey, type Router } from "./policy"
import type { VisualRunner } from "./visual-verify"
import { announce, runStandings, standingBudgets, type BudgetStanding } from "./budget"
import { TaskRunner, resumePoint } from "./runner"
import { FAILED_IN_A_ROW_NOTICE, nextFiring } from "./schedule"
import { readWorkflow, tasksFor } from "./workflow"
import type { WorkflowFile } from "./workflow"
import { planRestore, restore } from "./checkpoint"
import type { BrowserAllowRule, Run, RunPolicy, RunSource, RunVerdict, RunWorkflow, Task, TaskInput } from "./types"
import { routineLockKey, type SqliteRoutineRepository } from "./repository"
import type { ActionRunner } from "./action-runner"
import type { EpisodeCoordinator } from "./adaptive/coordinator"
import type { ContextManager } from "./adaptive/context-manager"
import type { Auditor } from "./verdict"

type Result<T> = { data?: T; error?: unknown }

type SchedulerOptions = {
  repository: SqliteRoutineRepository
  engineURL: string
  /** The engine's `authorization` header; defaults to this process's engine credentials. */
  authorization?: string
  intervalMs?: number
  lockTtlMs?: number
  /** The web actions a scheduled action drives (WA-7). Absent means action routines fail closed. */
  actions?: ActionRunner
  /** Where a run's episode is captured at its terminal boundaries (FH-002). Absent records none. */
  episodes?: EpisodeCoordinator
  /** Where a run prompt's context is planned and, opt-in, selected among (FH-024). Absent selects none. */
  context?: ContextManager
  /** The auditor model a finished agent task is judged by (RP-06). Absent judges by the rule alone. */
  auditor?: Auditor
  /** A verify task's picture of the desktop's preview (BU-06). Absent captures nothing. */
  previewCapture?: PreviewCapture
  /** The routing model a run's next task may be moved to its fallback by (PI-04). Absent routes by the rule alone. */
  router?: Router
  /** A verify task's look at the desktop's preview (CL-4). Absent, a task that declares one does not run it. */
  visualCheck?: VisualRunner
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

/** A best-of-n variant that is not `provider/model`; refused before any run of the batch starts. */
export class InvalidModelError extends Error {
  constructor(readonly key: string) {
    super(`Not a model: ${key}. Write it as provider/model.`)
    this.name = "InvalidModelError"
  }
}

export class RoutineScheduler {
  readonly repository: SqliteRoutineRepository
  readonly engineURL: string
  readonly engine: Engine
  readonly intervalMs: number
  readonly lockTtlMs: number
  readonly actions?: ActionRunner
  readonly episodes?: EpisodeCoordinator
  readonly context?: ContextManager
  readonly auditor?: Auditor
  readonly previewCapture?: PreviewCapture
  readonly router?: Router
  readonly visualCheck?: VisualRunner
  private readonly owner = crypto.randomUUID()
  private readonly stopping = new Set<string>()
  /**
   * The runs stopped at a budget mid-step (UL-08), with the budget's reason. The runner reads it the
   * way it reads `stopping`; a run awaiting at the gate does not outlive this process (it is failed on
   * restart), so neither does this.
   */
  private readonly overBudget = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(options: SchedulerOptions) {
    this.repository = options.repository
    this.engineURL = options.engineURL.replace(/\/$/, "")
    this.engine = new Engine(this.engineURL, options.authorization)
    this.intervalMs = options.intervalMs ?? 30_000
    this.lockTtlMs = options.lockTtlMs ?? 24 * 60 * 60 * 1000
    this.actions = options.actions
    this.episodes = options.episodes
    this.context = options.context
    this.auditor = options.auditor
    this.previewCapture = options.previewCapture
    this.router = options.router
    this.visualCheck = options.visualCheck
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

  async runNow(routineID: string, inputs?: Record<string, string>) {
    const run = await this.begin(routineID, Date.now(), inputs)
    if (!run) throw new RoutineBusyError()
    if (run.status === "running") void this.execute(run)
    return run
  }

  /**
   * Start a run of tasks that no routine asked for.
   *
   * The same path a routine takes, minus the schedule: a run, its tasks, and the runner. It is what
   * a workflow will use once H-21 can describe one, and what makes a multi-task run testable today.
   */
  async runTasks(input: {
    tasks: TaskInput[]
    directory?: string
    toolLimitMs?: number
    outside?: boolean
    /** Refuse the shell for every task of this run (H-47). Absent means the engine's own tools. */
    shell?: boolean
    /** Context packs every task of this run is given (H-31). */
    packs?: string[]
    /** Give each writing task its own worktree (H-29). */
    worktrees?: boolean
    /** Model per role, a fallback, and a budget (H-30). */
    policy?: RunPolicy
    /** The approval an action task runs under (WA-7). Without it, an action task fails closed. */
    allow?: BrowserAllowRule[]
    /** The workflow these tasks came from (RP-01). */
    workflow?: RunWorkflow
  }) {
    if (input.tasks.length === 0) throw new Error("A run needs at least one task")
    const run = this.repository.startRun({ type: "manual" }, Date.now(), input.directory, {
      ...(input.toolLimitMs ? { toolLimitMs: input.toolLimitMs } : {}),
      ...(input.outside ? { outside: true } : {}),
      ...(input.shell === false ? { shell: false } : {}),
      ...(input.packs && input.packs.length > 0 ? { packs: input.packs } : {}),
      ...(input.worktrees ? { worktrees: true } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.allow && input.allow.length > 0 ? { allow: input.allow } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
    })
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
   * The same task, once per model (H-44).
   *
   * One run per model rather than one run of N tasks: what a person compares is a whole run — what
   * it cost, how long it took, what it touched, what its check said — and H-33's comparison reads
   * runs. Each variant is a single task named after the model it runs on, and nothing else differs.
   *
   * Every model is checked before any run starts: a batch that quietly dropped one of its variants
   * would answer a different question than the one it was asked.
   */
  runBestOfN(input: {
    prompt: string
    models: string[]
    directory?: string
    packs?: string[]
    worktrees?: boolean
    policy?: RunPolicy
  }) {
    const variants = input.models.map((key) => {
      const model = parseModelKey(key)
      if (!model) throw new InvalidModelError(key)
      return { key, model }
    })
    return Promise.all(
      variants.map((variant) =>
        this.runTasks({
          tasks: [{ name: variant.key, prompt: input.prompt, model: variant.model }],
          directory: input.directory,
          ...(input.packs && input.packs.length > 0 ? { packs: input.packs } : {}),
          ...(input.worktrees ? { worktrees: true } : {}),
          ...(input.policy ? { policy: input.policy } : {}),
        }),
      ),
    )
  }

  /**
   * Start a run from a workflow (H-21).
   *
   * The workflow decides what the tasks are; everything after that is the path a manual run already
   * takes. That is the point of writing processes down as files: the supervisor, the stream,
   * verification and the retry do not learn anything new.
   */
  async runWorkflow(input: {
    name: string
    inputs?: Record<string, string>
    directory?: string
    packs?: string[]
    worktrees?: boolean
    policy?: RunPolicy
    /** Stop the task list at this task id, inclusive (HF-1). */
    until?: string
  }) {
    const file = await readWorkflow(input.name, input.directory)
    if (!file) throw new UnknownWorkflowError(input.name)
    const workflow = file.workflow
    const filled = { ...(workflow.inputDefaults ?? {}), ...(input.inputs ?? {}) }
    const missing = workflow.inputs.filter((name) => !filled[name]?.trim())
    if (missing.length > 0) throw new MissingInputsError(missing)
    const until = input.until?.trim() ? input.until.trim() : undefined
    const policy = withUnattended(input.policy, workflow)
    return this.runTasks({
      tasks: tasksFor(workflow, input.inputs ?? {}, until),
      directory: input.directory,
      // A workflow is a file, so its ceiling, its bypass, its trees and its shell are written
      // in the file too (H-47, H-29); the launcher can still ask for worktrees on top.
      ...(workflow.toolLimitMs ? { toolLimitMs: workflow.toolLimitMs } : {}),
      ...(workflow.outside ? { outside: true } : {}),
      ...(workflow.shell === false ? { shell: false } : {}),
      ...(input.packs && input.packs.length > 0 ? { packs: input.packs } : {}),
      ...(input.worktrees || workflow.worktrees ? { worktrees: true } : {}),
      ...(policy ? { policy } : {}),
      workflow: this.identify(file, filled),
    })
  }

  /**
   * What a run says it executed (RP-01): the workflow, the version of its file and the inputs. The
   * file is kept once per content, so a later edit changes what the next run executes and nothing
   * about a past one.
   */
  private identify(file: WorkflowFile, inputs: Record<string, string>): RunWorkflow {
    const hash = createHash("sha256").update(file.source).digest("hex")
    this.repository.recordWorkflowVersion({ hash, name: file.name, scope: file.scope, source: file.source })
    return { name: file.name, scope: file.scope, hash, inputs }
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
    const runner = new TaskRunner(this.repository, this.engine, this.actions, this.episodes, this.context, this.auditor, this.previewCapture, this.router, this.visualCheck)
    try {
      const outcome = await runner.execute(run, {
        directory,
        stopped: () => this.stopping.has(runID),
        overBudget: () => this.overBudget.get(runID),
      })
      if (outcome === "paused" && !this.stopping.has(runID)) return this.repository.awaitRun(runID)
      // A task the browser stopped on its own is the run called off too, even though the scheduler
      // never set its own flag (WA-7).
      const halted = this.stopping.has(runID) || outcome === "stopped"
      this.finishRun(runID, halted ? "stopped" : "success")
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
    // A run held for a request mid-turn (RP-05) is still driven: what lets it go is the answer.
    if (!run || run.status !== "awaiting" || run.paused === "request") return undefined
    // A budget pause is not a gate: letting it through means the budget stops being checked (H-30),
    // or the very next check would pause it again on the same totals. A task the budget stopped
    // mid-turn (UL-08) is done again, as a new attempt, like any retry.
    if (run.paused === "budget") {
      const stopped = this.repository
        .listTasks(runID)
        .filter((task) => task.status === "failed" && run.overBudget !== undefined && task.error === run.overBudget)
      this.repository.approveBudget(runID)
      this.overBudget.delete(runID)
      if (stopped.length > 0) this.repository.addTasks(runID, stopped.map(againOf))
    }
    if (!this.repository.resumeRun(runID)) return undefined
    void this.drive(runID, run.directory)
    return this.repository.getRun(runID)
  }

  /**
   * Do a task again, as a new task of the same run (H-12).
   *
   * A retry is a new task rather than the same one run twice, for the reason H-22 settled: repeating
   * the row would erase what the first attempt did, said and cost. It is added to the run the task
   * belongs to, so the run stays what is being supervised, and a run that had finished is reopened —
   * which is the whole point of retrying from the supervisor. A run at a gate is refused: it has
   * nobody driving it, so the task would sit queued forever.
   */
  retryTask(taskID: string, options: { model?: TaskInput["model"] } = {}) {
    const task = this.repository.getTask(taskID)
    if (!task) return undefined
    const run = this.repository.getRun(task.runID)
    if (!run) return undefined
    if (run.status === "awaiting") throw new Error("Approve or stop the run before retrying a task")
    const [created] = this.repository.addTasks(run.id, [
      {
        name: task.name,
        prompt: task.prompt,
        kind: task.kind,
        ...(task.command ? { command: task.command } : {}),
        ...(task.action ? { action: task.action } : {}),
        ...(task.visual ? { visual: task.visual } : {}),
        agent: task.agent,
        model: options.model ?? task.model,
        attempt: (task.attempt ?? 1) + 1,
        retryOf: task.id,
      },
    ])
    // A run still going picks the new task up by itself; a finished one has to be reopened first.
    if (run.status !== "running") {
      this.repository.reopenRun(run.id)
      void this.drive(run.id, run.directory)
    }
    return created
  }

  /**
   * Take a queued task off the run (HF-4).
   *
   * Only queued work can be cancelled: a running task has an engine turn in flight, which is
   * stopped by stopping the run instead. Dependents decide against the stopped row through the
   * same `decide` path as any other failure, so nothing behind it runs blind and the skip says why.
   */
  cancelTask(taskID: string) {
    const task = this.repository.getTask(taskID)
    if (!task) return undefined
    if (task.status !== "queued") throw new Error("Only a queued task can be cancelled; stop the run to halt one in flight")
    this.repository.finishTask(task.id, "stopped", { error: "Cancelled" }, Date.now())
    return this.repository.getTask(task.id)
  }

  /**
   * What resuming a run would do (RP-04), before it does it: the tasks that run, and the checkpoint
   * the folder goes back to with what restoring it would write and delete. Asked first and shown,
   * because the folder may have changed since the run ended and restoring overwrites that.
   */
  async resumePlan(runID: string, fromTask?: string) {
    const point = this.resumePoint(runID, fromTask)
    if (!point) return undefined
    return {
      tasks: point.runs,
      ...(point.checkpoint
        ? { checkpoint: point.checkpoint, plan: await planRestore(point.checkpoint.directory, point.checkpoint.sha) }
        : {}),
    }
  }

  /**
   * Pick up a run that failed, was stopped or lost its process (HF-5, RP-04), from a task or from
   * where it broke.
   *
   * Only what has not succeeded runs again (`resumePoint`): a task that ran is attempted again as a
   * new task, one that never started goes back to the queue, and succeeded ones stay as they are. The
   * folder is put back first to how it looked before that work, and where it was is kept as a
   * checkpoint like any restore's, so the resume can be undone. A requeued task may repeat side
   * effects outside the folder that its lost attempt already made, which is why the requeue reason
   * stays on the row.
   */
  async resume(runID: string, options: { fromTask?: string } = {}) {
    const point = this.resumePoint(runID, options.fromTask)
    if (!point) return undefined
    if (point.runs.length === 0) throw new Error("Nothing left to resume: every task settled")
    if (point.checkpoint) {
      const done = await restore({
        directory: point.checkpoint.directory,
        sha: point.checkpoint.sha,
        safetyTitle: `Before resuming from "${point.checkpoint.title}"`,
      })
      this.repository.addCheckpoint(done.safety)
    }
    const fresh = point.again.filter((task) => task.startedAt === undefined)
    this.repository.requeueTasks(fresh.map((task) => task.id))
    this.repository.addTasks(
      runID,
      point.again.filter((task) => task.startedAt !== undefined).map(againOf),
    )
    const run = this.repository.getRun(runID)!
    this.repository.reopenRun(runID)
    void this.drive(runID, run.directory)
    return this.repository.getRun(runID)
  }

  private resumePoint(runID: string, fromTask?: string) {
    const run = this.repository.getRun(runID)
    if (!run) return undefined
    if (run.status === "running" || run.status === "awaiting")
      throw new Error("The run is still active; stop it before resuming")
    return resumePoint(run, this.repository.listTasks(runID), this.repository.listCheckpoints({ runID }), fromTask)
  }

  private finishRun(runID: string, status: "success" | "failed" | "stopped", error?: string) {
    this.repository.finishRun(runID, status, error)
    this.writeReport(runID, status, error)
    // The run's boundary (FH-002). After the report, so the episode can name it as evidence.
    this.episodes?.captureRun(runID)
    this.stopping.delete(runID)
    this.overBudget.delete(runID)
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
    const ending = runEnding(status, run.verdict?.value)
    // The task that decided the verdict, in its own words, unless the run's error already says it.
    const decided =
      run.verdict && run.verdict.value !== "verified" && run.verdict.reason !== error
        ? `${tasks.find((task) => task.id === run.verdict!.taskID)?.name ?? "A task"}: ${run.verdict.reason}`
        : undefined
    const lines = [
      `Run ${ending} in ${seconds}s`,
      ...(error ? ["", error] : []),
      ...(decided ? ["", decided] : []),
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
      title: `Run ${ending}`,
      producer: "harness",
      content: lines.join("\n"),
      directory: run.directory,
      runID,
      sessionID: run.sessionID,
    })
  }

  /**
   * Holds what the ledger just stored against every budget it touches (UL-08): called on each insert,
   * so a budget is decided at the step that crosses it, here, where the agent cannot write (P7).
   *
   * The runs the sessions work for are checked against their own budgets and the standing ones that
   * cover them; every standing budget is checked too, because a conversation spends today's budget
   * as much as a run does. A warning is said once. A crossed limit is said once and stops every run
   * going under it: the turn in flight is interrupted and its task fails with the budget's reason.
   * A conversation is never interrupted: it is the person's own, so it is told, not stopped.
   */
  checkBudgets(sessionIDs: string[], now = Date.now()) {
    const sessionFor = new Map<string, string>()
    for (const sessionID of sessionIDs) {
      const runID = this.repository.sessionBudgetScope(sessionID).runID
      if (runID && !sessionFor.has(runID)) sessionFor.set(runID, sessionID)
    }
    const going = this.repository.listRunning().filter((run) => run.status === "running" && !run.budgetApproved)
    // Today's standing budgets, once for this insert: a run's own standings repeat them per run.
    for (const entry of standingBudgets(this.repository, now)) {
      announce(this.repository, entry, sessionIDs[0] ? { sessionID: sessionIDs[0] } : {})
      if (entry.level !== "hard") continue
      for (const run of going.filter((candidate) => covers(entry, candidate))) this.haltForBudget(run.id, entry.reason)
    }
    for (const run of going.filter((candidate) => sessionFor.has(candidate.id))) {
      for (const entry of runStandings(this.repository, run, now).filter((standing) => standing.scope === "run")) {
        announce(this.repository, entry, { runID: run.id, sessionID: sessionFor.get(run.id)! })
        if (entry.level === "hard") this.haltForBudget(run.id, entry.reason)
      }
    }
  }

  /** Stops a run's turns at a budget: the flag the runner reads, then each live session interrupted. */
  private haltForBudget(runID: string, reason: string) {
    if (this.overBudget.has(runID) || this.stopping.has(runID)) return
    this.overBudget.set(runID, reason)
    this.repository.setPaused(runID, "budget", reason)
    const live = this.repository
      .listTasks(runID)
      .flatMap((task) => (task.status === "running" && task.sessionID ? [task.sessionID] : []))
    void Promise.all(live.map((session) => this.engine.interrupt(session).catch(() => undefined)))
  }

  async stopRun(runID: string) {
    const run = this.repository.getRun(runID)
    if (!run || (run.status !== "running" && run.status !== "awaiting")) return run
    this.stopping.add(runID)
    // A run held at a gate has nobody driving it, so nothing would ever read the flag and finish it.
    // Stopping is also how a gate is refused: the answer to "let this through?" can be no.
    if (run.status === "awaiting" && run.paused !== "request") {
      this.finishRun(runID, "stopped", "Stopped at the gate")
      return this.repository.getRun(runID)
    }
    // The work is in the tasks' sessions: a run of one task has no thread of its own, and a longer
    // run's thread sits idle while its tasks run (TI-01). Each live one is interrupted, then the
    // thread; the runner also interrupts as it notices the flag, so a session created in between is
    // not missed.
    const live = this.repository
      .listTasks(runID)
      .flatMap((task) => (task.status === "running" && task.sessionID ? [task.sessionID] : []))
    await Promise.all(
      [...live, ...(run.sessionID ? [run.sessionID] : [])].map((session) => this.engine.interrupt(session)),
    )
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
      // Every routine that is due, not the first one (TI-07): one whose last run still holds its lock
      // is skipped by `begin`, and must not keep the others from firing.
      // A firing is a beat of the schedule or the retry a failed run earned (RP-07).
      const now = Date.now()
      for (const routine of this.repository.list()) {
        const firing = nextFiring(routine, now)
        if (!firing || firing.at > now) continue
        const run = await this.begin(routine.id, now, undefined, firing.retry?.attempt)
        if (run?.status === "running") void this.execute(run)
      }
    } finally {
      this.ticking = false
    }
  }

  private async begin(routineID: string, now: number, overrides?: Record<string, string>, attempt?: number) {
    const key = routineLockKey(routineID)
    if (!this.repository.acquire(key, this.owner, now, this.lockTtlMs)) return undefined
    const source: RunSource = { type: "routine", routineID }
    // A retry says which try it is, so the next one knows how long to wait and when to give up.
    const tries = attempt && attempt > 1 ? { attempt } : {}
    const routine = this.repository.get(routineID)
    if (!routine) {
      this.repository.release(key, this.owner)
      return undefined
    }
    // A routine drives a web action, a workflow's tasks, or one prompt. An action is one
    // deterministic task with no model turn, and the run carries the consent it was saved with
    // (WA-7); without that consent `runActionTask` refuses before the browser opens.
    if (routine.action) {
      const inputs = { ...(routine.action.inputs ?? {}), ...(overrides ?? {}) }
      const run = this.repository.startRun(source, now, routine.projectDirectory, {
        ...(routine.policy ? { policy: routine.policy } : {}),
        ...(routine.allow && routine.allow.length > 0 ? { allow: routine.allow } : {}),
        ...tries,
      })
      this.repository.addTasks(run.id, [
        {
          name: routine.name,
          prompt: "",
          kind: "action",
          action: { id: routine.action.id, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) },
        },
      ])
      return run
    }
    // A routine runs one prompt, or the tasks of a workflow file (HF-8). Either way the run
    // carries the routine's policy, so budgets and fallbacks apply on schedule as on demand.
    if (!routine.workflow) {
      const run = this.repository.startRun(source, now, routine.projectDirectory, {
        ...(routine.policy ? { policy: routine.policy } : {}),
        ...tries,
      })
      this.repository.addTasks(run.id, [
        { name: routine.name, prompt: routine.prompt, agent: routine.agent, model: routine.model },
      ])
      return run
    }
    // Read before the run starts, so the run names the version it executes (RP-01); a file that is
    // gone still gets a failed run below, saying so.
    const file = await readWorkflow(routine.workflow.name, routine.projectDirectory)
    const filled = { ...(file?.workflow.inputDefaults ?? {}), ...(routine.workflow.inputs ?? {}), ...(overrides ?? {}) }
    const policy = withUnattended(routine.policy, file?.workflow)
    const run = this.repository.startRun(source, now, routine.projectDirectory, {
      ...(policy ? { policy } : {}),
      ...(file ? { workflow: this.identify(file, filled) } : {}),
      ...tries,
    })
    try {
      if (!file) throw new UnknownWorkflowError(routine.workflow.name)
      const workflow = file.workflow
      const missing = workflow.inputs.filter((name) => !filled[name]?.trim())
      if (missing.length > 0) throw new MissingInputsError(missing)
      const tasks = tasksFor(workflow, filled)
      this.repository.addTasks(run.id, tasks)
      // More than one task earns the thread a reader follows, the same as a manual run.
      if (tasks.length > 1) {
        const title = tasks.map((task) => task.name).join(" → ")
        const root = await this.engine
          .createSession({
            directory: routine.projectDirectory,
            title: title.length > 80 ? `${title.slice(0, 77)}…` : title,
          })
          .catch(() => undefined)
        if (root) this.repository.attachSession(run.id, root.id)
      }
    } catch (cause) {
      // The file was valid when the routine was saved and is gone now. The failed run stays in
      // history saying so, instead of the schedule silently skipping a beat.
      this.repository.finishRun(run.id, "failed", cause instanceof Error ? cause.message : String(cause), now)
      this.episodes?.captureRun(run.id)
      this.repository.release(key, this.owner)
      this.noticeFailures(routineID)
    }
    // Read back rather than the object made above: a start that failed is `failed` in the store, and
    // handing on the stale `running` copy had it executed with no tasks and overwritten as a success.
    return this.repository.getRun(run.id)
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
      const runner = new TaskRunner(this.repository, this.engine, this.actions, this.episodes, this.context, this.auditor, this.previewCapture, this.router, this.visualCheck)
      const outcome = await runner.execute(run, {
        directory: routine.projectDirectory,
        stopped: () => this.stopping.has(run.id),
        overBudget: () => this.overBudget.get(run.id),
      })
      // A routine's run is one task with no gate, so this cannot happen today — but saying "success"
      // for a run that stopped halfway is the kind of lie that survives a refactor.
      if (outcome === "paused" && !this.stopping.has(run.id)) {
        this.repository.awaitRun(run.id)
        this.repository.release(routineLockKey(routine.id), this.owner)
        return
      }
      // A run of one task has no thread of its own, so the session the reader wants is the task's.
      // A run that already has one — a workflow's thread from `begin` — keeps it.
      const [task] = this.repository.listTasks(run.id)
      const fresh = this.repository.getRun(run.id) ?? run
      if (task?.sessionID && !fresh.sessionID) this.repository.attachSession(run.id, task.sessionID)
      const halted = this.stopping.has(run.id) || outcome === "stopped"
      this.finish(run, halted ? "stopped" : "success", halted ? "Routine stopped" : undefined)
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
    this.episodes?.captureRun(run.id)
    if (run.source.type === "routine") this.repository.release(routineLockKey(run.source.routineID), this.owner)
    this.stopping.delete(run.id)
    this.overBudget.delete(run.id)
    if (run.source.type === "routine") this.noticeFailures(run.source.routineID)
  }

  /**
   * Say so when a routine has failed often enough in a row (RP-07): once per streak, on the run that
   * reaches the notice, so a routine that keeps failing does not say it again with every run. The
   * remote host pushes it to the phone; the app shows it too.
   */
  private noticeFailures(routineID: string) {
    const routine = this.repository.get(routineID)
    if (!routine || routine.failedInARow !== FAILED_IN_A_ROW_NOTICE) return
    // The newest of the failed runs that has a session to open; a run that failed to start has none.
    const sessionID = routine.runs
      .filter((run) => run.status === "success" || run.status === "failed")
      .slice(0, FAILED_IN_A_ROW_NOTICE)
      .find((run) => run.sessionID)?.sessionID
    this.repository.append({
      type: "routine.failing",
      routineID,
      name: routine.name,
      failedInARow: routine.failedInARow,
      ...(sessionID ? { sessionID } : {}),
    })
  }
}

/**
 * A run's policy with the workflow file's `unattended` (RP-05) when the caller did not say: the routine
 * or the launcher speaks for this run, the file for every run of it.
 */
function withUnattended(policy: RunPolicy | undefined, workflow: { unattended?: RunPolicy["unattended"] } | undefined) {
  if (policy?.unattended || !workflow?.unattended) return policy
  return { ...policy, unattended: workflow.unattended }
}

/**
 * How a run ended, said once (UX-04): a run whose turns all finished ended the way its verdict says
 * (RP-06), so a report of a run whose work failed is never titled "success" (P4). A run that failed
 * or was stopped says that; one with nothing judged says it succeeded, which is all that is known.
 */
function runEnding(status: string, verdict: RunVerdict["value"] | undefined) {
  if (status !== "success" || !verdict) return status === "success" ? "succeeded" : status
  return { verified: "verified", unverified: "not verified", "needs-user": "needs your input", failed: "failed" }[verdict]
}

/** Whether a standing budget covers a run: today's covers all of them. */
function covers(entry: BudgetStanding & { target?: string }, run: Run) {
  if (entry.scope === "day") return true
  if (entry.scope === "workflow") return run.workflow?.name === entry.target
  return run.source.type === "routine" && run.source.routineID === entry.target
}

/** A task done again as a new attempt of itself, as a retry and a resume make it (H-12, RP-04). */
function againOf(task: Task): TaskInput {
  return {
    name: task.name,
    prompt: task.prompt,
    kind: task.kind,
    ...(task.command ? { command: task.command } : {}),
    ...(task.action ? { action: task.action } : {}),
    agent: task.agent,
    model: task.model,
    ...(task.retries !== undefined ? { retries: task.retries } : {}),
    ...(task.gate ? { gate: task.gate } : {}),
    ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
    ...(task.when ? { when: task.when } : {}),
    ...(task.foreach ? { foreach: task.foreach } : {}),
    ...(task.require ? { require: task.require } : {}),
    ...(task.visual ? { visual: task.visual } : {}),
    attempt: task.attempt + 1,
    retryOf: task.id,
  }
}
