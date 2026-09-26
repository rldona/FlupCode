import { sessionPermission, type Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, Task, TaskStatus, Artifact } from "./types"
import { evidenceText, focusedEvidence, runVerify, type VerifyReport } from "./verify"
import { externalCommand, runExternal } from "./external"
import { take } from "./checkpoint"
import { parseFindings } from "./findings"
import { packFiles, packRefs, expandArtifactRefs } from "./packs"
import { parsePlan } from "./plan"
import { budgetReason, fallbackModel, modelForTask } from "./policy"
import { ActionRunError } from "./action-runner"
import type { ActionRunner } from "./action-runner"
import { BrowserError } from "./browser"
import { actionInputProblem, missingAllowRules } from "./action-allow"

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The collision two action runs of one project meet at `browser.start` (WA-7). */
const isBrowserBusy = (cause: unknown): boolean => cause instanceof BrowserError && cause.code === "browser_busy"

/**
 * Runs an action, waiting out a project whose browser another run still holds (WA-7).
 *
 * Only `browser_busy` is retried: any other failure is the recipe's own and waiting does not help.
 */
async function withBrowserStartRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0
  while (true) {
    attempt += 1
    try {
      return await run()
    } catch (cause) {
      if (!isBrowserBusy(cause) || attempt >= ACTION_START_ATTEMPTS) throw cause
      await Bun.sleep(ACTION_START_RETRY_DELAY_MS * attempt)
    }
  }
}

/** A task has settled once it will not change again; the graph only moves on settled work. */
const TERMINAL = new Set<TaskStatus>(["success", "failed", "skipped", "stopped"])

/**
 * How many tasks of one run may be in flight at once (H-28).
 *
 * Parallel work is the point of the DAG, but an unbounded fan-out would start every root at once and
 * spend whatever it costs before anybody can look. Four is the audit's own ceiling for concurrent
 * workflows, and it is stated here rather than buried in a workflow file.
 */
const RUN_CONCURRENCY = 4

/**
 * How many times an action task waits for a project's browser before giving up (WA-7).
 *
 * Two action runs of the same project collide on the one-browser-per-project reservation, and the
 * loser only has to outlast the winner's run. Three attempts with a growing wait are enough for a
 * short recipe without letting a stuck reservation hold a task forever.
 */
const ACTION_START_ATTEMPTS = 3
const ACTION_START_RETRY_DELAY_MS = 250

/**
 * What an external worker is doing right now, by task id (H-38).
 *
 * Not stored, for the reason H-12 settled for engine tools: it changes by the second, and on the
 * event log it would drown everything else. The activity endpoint asks while somebody is looking.
 */
const externalLive = new Map<string, { tool: string; since: number; tail: string }>()
export const externalActivity = (taskID: string) => externalLive.get(taskID)

/**
 * What the executor is told on a retry.
 *
 * Its own instructions again, and what the check said about the last attempt. Nothing else: the
 * harness knows what failed, not how to fix it, and inventing advice here would put words in front
 * of the evidence.
 */
function retryPrompt(task: Task, evidence: string) {
  return [task.prompt, "", "The previous attempt did not pass verification:", "", evidence].join("\n")
}

const failureSummary = (report: { steps: Array<{ name: string; exitCode: number }>; problem?: string }) => {
  // A declaration that cannot be read is its own answer, and the one the reader can act on.
  if (report.problem) return `Verification could not run: ${report.problem}`
  const failed = report.steps.filter((step) => step.exitCode !== 0).map((step) => step.name)
  if (failed.length === 0) return "Nothing to verify: the project declares no verify steps"
  return `Verification failed: ${failed.join(", ")}`
}

/**
 * What a task is handed from the ones before it.
 *
 * A handoff, not a transcript (§6.2): tasks receive what their dependencies concluded, not whole
 * conversations. It keeps the prompt small and the dependency explicit — and it is why a task stores
 * its output at all. With a graph a task may have several (H-28), so they are joined.
 */
function compose(task: Task, handoff: string | undefined, context?: string, memory?: string) {
  const body = !handoff
    ? task.prompt
    : [`Previous step (${handoff.length > 4000 ? "truncated" : "complete"}):`, handoff.slice(0, 4000), "", task.prompt].join(
        "\n",
      )
  const head = [
    memory ? `Project memory:\n${memory}` : "",
    context ? `Context packs:\n${context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  if (!head) return body
  return [`${head}`, "", body].join("\n")
}

/** A name the engine can turn into a folder and a branch: lowercase, dashes, no spaces. */
function worktreeName(task: string) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "task"
}

/** What a task is waiting for, and what lets it run. */
type Decision = { action: "run" } | { action: "wait" } | { action: "skip"; reason: string }

type RunContext = {
  run: Run
  options: { directory?: string; stopped?: () => boolean }
  stopped: () => boolean
  parentID?: string
  packRefsList: string[]
  memory?: string
  /** What each settled task concluded, by task id, so its dependents can be handed it. */
  handoffs: Map<string, string | undefined>
  /** The tree each task ran in, by task id, so a check checks the work it is about (H-29). */
  directories: Map<string, string | undefined>
  /** The first failure nobody declared they expected; it ends the run. */
  failure?: string
  /**
   * A task was stopped for a reason the scheduler did not ask for (WA-7).
   *
   * A browser stop reaches the action runner, which reports `stopped`; without recording it here the
   * run would finish `success` around a task that stopped. Unlike `failure` this does not throw and
   * does not carry an error: the run was called off, it did not fail.
   */
  halted?: boolean
  /** Why the run stopped taking new work: a gate, or a budget. */
  pause?: "gate" | "budget"
}

/**
 * Runs the tasks of a run, as a graph.
 *
 * Sequential used to be the whole story: the order in the file was the dependency, and parallelism
 * needed the write-conflict rules and worktrees of H-29 to be safe. Now a task says what it waits
 * for (`dependsOn`), or opts out of the file order (`parallel`), and everything whose dependencies
 * have settled runs at once. A workflow that says nothing about the graph still runs in order — the
 * implicit dependency is the task above — so v1 files did not have to change.
 *
 * A failed task still stops the run, and the work behind it is left queued rather than run against a
 * state nobody verified. The exception is a task that declared it expects that failure with `when`:
 * that is a recovery step, and the run is allowed to reach it.
 */
export class TaskRunner {
  constructor(
    private readonly repository: SqliteRoutineRepository,
    private readonly engine: Engine,
    /**
     * The web actions a deterministic action task drives (WA-7).
     *
     * Absent means this server was built without a browser, and an action task fails closed rather
     * than pretending it ran. An agent task never touches it.
     */
    private readonly actions?: ActionRunner,
  ) {}

  /**
   * Puts the work that failed verification back on the run, once.
   *
   * A retry is a **new task**, not the same one run again. Repeating a row would overwrite what the
   * first attempt did, said and cost, and this whole ticket is about keeping evidence — a reader
   * has to be able to see that the first attempt failed, what it was told, and what the second one
   * changed. It also keeps the totals honest: two attempts cost two attempts.
   *
   * Returns false when there is no budget left, or nothing before the check to attempt again.
   */
  private scheduleRetry(run: Run, verify: Task, evidence: string) {
    const budget = verify.retries ?? 0
    if (budget <= 0) return false
    const agents = this.repository.listTasks(run.id).filter((entry) => entry.kind === "agent")
    // The task the check is about, when it says so; a v1 check has no `dependsOn`, so the nearest
    // agent task before it is the work it was checking.
    const executor = (
      verify.dependsOn && verify.dependsOn.length > 0
        ? agents.filter((entry) => verify.dependsOn!.includes(entry.name))
        : agents.filter((entry) => entry.position < verify.position)
    ).at(-1)
    if (!executor) return false
    this.repository.addTasks(run.id, [
      {
        name: executor.name,
        prompt: retryPrompt(executor, evidence),
        kind: "agent",
        agent: executor.agent,
        // A root: the failure that produced it is behind it, and it must not wait on it.
        dependsOn: [],
        // The policy's fallback, when it names one (H-30): a retry that repeats the failed model is
        // asking the same question and expecting a different answer.
        model: fallbackModel(run.policy, executor.model),
        attempt: executor.attempt + 1,
        retryOf: executor.id,
      },
      {
        name: verify.name,
        prompt: "",
        kind: "verify",
        // The check follows the attempt it caused, and waits for the newest one.
        dependsOn: [executor.name],
        // One less: the budget is spent as it is used, so a run cannot loop whatever goes wrong.
        retries: budget - 1,
        attempt: verify.attempt + 1,
        retryOf: verify.id,
      },
    ])
    return true
  }

  /**
   * Files what the checks said, as findings.
   *
   * Only what can be anchored: `locate` leaves a file outside the run's folder absolute, and a
   * finding on a file the diff cannot show would be a comment with nowhere to go. It stays in the
   * evidence, which is read as text.
   *
   * Severity is high for all of them, and that is not a guess: the gate failed the run over these.
   */
  private recordFailures(report: VerifyReport, runID: string, taskID: string, directory?: string) {
    if (!directory) return
    const findings = report.steps.flatMap((step) =>
      (step.failures ?? [])
        .filter((failure) => !failure.file.startsWith("/"))
        .map((failure) => ({
          file: failure.file,
          ...(failure.line !== undefined ? { line: failure.line } : {}),
          severity: "high" as const,
          title: failure.message,
          source: "check" as const,
          detail: [step.name, failure.rule].filter(Boolean).join(" · ") || undefined,
          directory,
          runID,
          taskID,
        })),
    )
    if (findings.length > 0) this.repository.addFindings(findings)
  }

  /**
   * Whether the run has spent its budget, and should stop and ask (H-30).
   *
   * Summed from the tasks because that is where a token count is first written — after the turn, not
   * during it. A run whose budget was already approved is not asked again.
   */
  private pauseForBudget(run: Run) {
    if (run.budgetApproved || !run.policy?.budget) return false
    const totals = this.repository
      .listTasks(run.id)
      .reduce((sum, task) => ({ tokens: sum.tokens + (task.tokens ?? 0), cost: sum.cost + (task.cost ?? 0) }), {
        tokens: 0,
        cost: 0,
      })
    if (!budgetReason(run.policy, totals)) return false
    this.repository.setPaused(run.id, "budget")
    return true
  }

  /**
   * A closing note for a task, for the next one and for the record (H-31).
   *
   * Written by the engine in a session of its own, so it costs no turn of the task it is about, and
   * kept as a `handoff` artifact so a run can be read back without the transcripts. The raw answer is
   * the fallback: a note that could not be written must not lose what the task actually said.
   */
  private async handoffNote(run: Run, task: Task, answer: string | undefined, directory?: string) {
    if (!answer) return undefined
    const engine = this.engine as Engine & { handoff?: unknown }
    // A test that fakes the engine has no note to write; the caller gets the answer it already had.
    if (typeof engine.handoff !== "function") return answer
    try {
      const note = await this.engine.handoff({ directory, task: task.name, answer })
      if (!note) return answer
      this.repository.addArtifact({
        kind: "handoff",
        title: `${task.name} — handoff`,
        producer: "harness",
        content: note,
        directory,
        runID: run.id,
        taskID: task.id,
      })
      return note
    } catch {
      return answer
    }
  }

  /**
   * The tasks a task waits for, by name.
   *
   * An explicit `dependsOn` — including an empty one, which is what `parallel: true` becomes — is
   * used as written. A task that says nothing follows the one above it, which is the v1 rule. A
   * `when` names a task whose outcome decides this one, so it is waited for whether or not it was
   * listed.
   */
  private dependencies(task: Task, tasks: Task[]): string[] {
    const explicit = task.foreach
      ? [task.foreach]
      : task.dependsOn !== undefined
        ? task.dependsOn
        : task.retryOf
          ? []
          : (() => {
              const previous = tasks.filter((entry) => entry.position < task.position).at(-1)
              return previous ? [previous.name] : []
            })()
    const condition = task.when?.task
    return condition && !explicit.includes(condition) ? [...explicit, condition] : explicit
  }

  /** Whether every instance of a name has settled, and whether any of them succeeded. */
  private settled(name: string, tasks: Task[]): "ok" | "failed" | "pending" {
    const instances = tasks.filter((task) => task.name === name)
    if (instances.length === 0) return "failed"
    if (!instances.every((task) => TERMINAL.has(task.status))) return "pending"
    return instances.some((task) => task.status === "success" || task.status === "skipped") ? "ok" : "failed"
  }

  /** Whether `when` is answered yet, and if so, whether it lets the task run. */
  private condition(task: Task, tasks: Task[]): "run" | "skip" | "wait" {
    if (!task.when) return "run"
    const instances = tasks.filter((entry) => entry.name === task.when!.task)
    if (instances.length === 0) return "skip"
    if (!instances.every((entry) => TERMINAL.has(entry.status))) return "wait"
    return instances.some((entry) => (task.when!.is as TaskStatus[]).includes(entry.status)) ? "run" : "skip"
  }

  private decide(task: Task, tasks: Task[]): Decision {
    for (const name of this.dependencies(task, tasks)) {
      const state = this.settled(name, tasks)
      if (state === "pending") return { action: "wait" }
      if (state === "failed") {
        // A `when` that names this failure is the way through; otherwise the branch is dead and
        // saying so is better than leaving a row queued forever.
        const allowed =
          task.when?.task === name && task.when.is.some((status) => status === "failed" || status === "stopped")
        if (!allowed) return { action: "skip", reason: `Not run: ${name} did not succeed` }
      }
    }
    const condition = this.condition(task, tasks)
    if (condition === "wait") return { action: "wait" }
    if (condition === "skip")
      return {
        action: "skip",
        reason: `Not run: ${task.when!.task} did not end as ${task.when!.is.join(" or ")}`,
      }
    return { action: "run" }
  }

  /** An `@artifact:` ref answered with the artifact's content, newest of its kind (HF-6). */
  private artifactQuote(key: string, run: Run, directory?: string) {
    const exact = this.repository.getArtifact(key)
    if (exact) return { title: exact.title, kind: exact.kind, content: exact.content }
    const kind = key as Artifact["kind"]
    const byRun = this.repository.listArtifacts({ kind, runID: run.id })
    const latest = byRun.length > 0 ? byRun[0] : directory ? this.repository.listArtifacts({ kind, directory })[0] : undefined
    if (!latest) return undefined
    return { title: latest.title, kind: latest.kind, content: latest.content }
  }

  /** What the tasks before it concluded, joined: a graph task may have several (H-28). */
  private handoffFor(task: Task, tasks: Task[], context: RunContext) {
    const notes = this.dependencies(task, tasks)
      .map((name) =>
        tasks
          .filter((entry) => entry.name === name && entry.status === "success")
          .at(-1),
      )
      .map((instance) => (instance ? context.handoffs.get(instance.id) : undefined))
      .filter((note): note is string => !!note)
    return notes.length > 0 ? notes.join("\n\n") : undefined
  }

  /** The tree a task works in: the one its dependencies left, or the run's own (H-29). */
  private directoryFor(task: Task, tasks: Task[], context: RunContext) {
    const deps = this.dependencies(task, tasks).filter((name) => name !== task.when?.task)
    for (const name of [...deps].reverse()) {
      const instance = tasks.filter((entry) => entry.name === name && entry.status === "success").at(-1)
      const directory = instance ? context.directories.get(instance.id) : undefined
      if (directory) return directory
    }
    const previous = tasks.filter((entry) => entry.position < task.position).at(-1)
    return (previous ? context.directories.get(previous.id) : undefined) ?? context.options.directory
  }

  /** Whether some task declared it expects `name` to fail, which makes the failure survivable. */
  private expectsFailure(runID: string, name: string) {
    return this.repository.listTasks(runID).some(
      (task) =>
        task.when?.task === name && task.when.is.some((status) => status === "failed" || status === "stopped"),
    )
  }

  /**
   * Runs what is queued, and says why it stopped.
   *
   * Everything whose dependencies have settled starts at once, up to the ceiling, and the loop waits
   * on whichever finishes first. A gate or a budget stops new work but lets what is in flight finish,
   * so a pause is a clean boundary rather than a half-done task.
   */
  async execute(run: Run, options: { directory?: string; stopped?: () => boolean } = {}): Promise<"done" | "paused" | "stopped"> {
    const stopped = options.stopped ?? (() => false)
    const all = this.repository.listTasks(run.id)
    if (all.length === 0) return "done"
    // The run's own session is the thread a person reads; each task is a child of it, which is the
    // lineage the engine already keeps. A run of one task needs no thread of its own, and creating
    // one would leave an empty session in everybody's list.
    const parentID = all.length > 1 ? (this.repository.getRun(run.id)?.sessionID ?? run.sessionID) : undefined
    const context: RunContext = {
      run,
      options,
      stopped,
      parentID,
      // The run's context packs (H-31), as refs. Which of them are files depends on the tree the task
      // runs in, and with worktrees (H-29) that is the task's, not the run's.
      packRefsList:
        run.packs && run.packs.length > 0 && options.directory
          ? packRefs(this.repository.listPacks(options.directory), run.packs)
          : [],
      // The project's notes (H-37), handed to every turn so they do not have to be repeated.
      memory: options.directory
        ? this.repository
            .listProjectMemory(options.directory)
            .map((note) => `- ${note.text}`)
            .join("\n") || undefined
        : undefined,
      handoffs: new Map(),
      directories: new Map(),
    }
    const running = new Set<Promise<void>>()
    while (true) {
      if (stopped()) {
        for (const task of this.repository.listTasks(run.id).filter((entry) => entry.status === "queued"))
          this.repository.finishTask(task.id, "stopped", { error: "The run was stopped" })
        if (running.size === 0) break
        await Promise.race(running)
        continue
      }
      const tasks = this.repository.listTasks(run.id)
      const queued = tasks.filter((task) => task.status === "queued")
      if (queued.length === 0 && running.size === 0) break
      let started = 0
      let skipped = false
      for (const task of queued) {
        if (running.size >= RUN_CONCURRENCY || context.failure || context.pause || context.halted) break
        const decision = this.decide(task, tasks)
        if (decision.action === "skip") {
          this.repository.finishTask(task.id, "skipped", { error: decision.reason }, Date.now())
          // A skip changes what its dependents should do, so the decisions above are stale; go round
          // again with the new statuses rather than deciding the rest against an old graph.
          skipped = true
          break
        }
        if (decision.action === "wait") continue
        const promise = this.runTask(task, context).finally(() => running.delete(promise))
        running.add(promise)
        started++
      }
      if (skipped) continue
      if (running.size === 0 && started === 0) break
      await Promise.race(running)
    }
    if (context.failure && !stopped()) throw new Error(context.failure)
    // A task stopped by a browser the person closed is the run being called off: queued work stays
    // queued no longer, and the run is reported as stopped rather than as a clean success.
    if (context.halted && !stopped()) {
      for (const task of this.repository.listTasks(run.id).filter((entry) => entry.status === "queued"))
        this.repository.finishTask(task.id, "stopped", { error: "The run was stopped" })
      return "stopped"
    }
    return context.pause ? "paused" : "done"
  }

  /** One task, start to checkpoint. Never throws: a failure is recorded and ends the run at the loop. */
  private async runTask(task: Task, context: RunContext): Promise<void> {
    const run = context.run
    const { stopped } = context
    const tasks = this.repository.listTasks(run.id)
    const handoff = this.handoffFor(task, tasks, context)
    this.repository.startTask(task.id, Date.now())
    let directory = this.directoryFor(task, tasks, context)
    try {
      // A `foreach` task is a fan-out marker, not work (H-28): the plan it names is ready, so one task
      // is added per step and this row says what was expanded. Its dependents wait for all of them
      // because the steps share its name.
      if (task.foreach) return this.expand(task, context)
      // A verify task runs the project's own commands and keeps what they printed (H-22). No session
      // and no model: it costs time, not tokens, which is what makes it worth running after every
      // attempt rather than once at the end.
      if (task.kind === "verify") {
        const report = await runVerify(directory ?? process.cwd(), { stopped })
        const evidence = evidenceText(report)
        this.repository.finishTask(task.id, stopped() ? "stopped" : report.ok ? "success" : "failed", {
          output: evidence,
          error: report.ok ? undefined : failureSummary(report),
        })
        // And it is kept (H-14): the verdict of a check is the evidence the audit asks for, and it
        // outlives the task list, which only shows the last twenty runs.
        this.repository.addArtifact({
          kind: "verdict",
          title: `${task.name} — ${report.ok ? "passed" : "failed"}`,
          producer: "harness",
          content: evidence,
          directory,
          runID: run.id,
          taskID: task.id,
        })
        // Every failure the checks named, anchored on its line (H-22, and the structured output H-21
        // asks of this gate). They are findings like a review's, which means they are drawn on the
        // diff by the machinery H-32 already built.
        this.recordFailures(report, run.id, task.id, directory)
        context.handoffs.set(task.id, evidence)
        context.directories.set(task.id, directory)
        // The checks cost time, not tokens, but the run they belong to may already be over budget.
        if (this.pauseForBudget(run)) {
          context.pause = "budget"
          return
        }
        if (!report.ok && !stopped()) {
          // A failed check is not the end of the run if it was given a budget to try again. The
          // retry carries the evidence in its own prompt, so the handoff is cleared, not repeated.
          if (this.scheduleRetry(run, task, focusedEvidence(report))) return
          // Or if a task declared it expects this failure: that is a recovery step, not an ending.
          if (this.expectsFailure(run.id, task.name)) return
          // The task already recorded the failure; ending the run here is the loop's job, and doing
          // it by throwing would let the catch below overwrite the evidence with a bare message.
          context.failure = failureSummary(report)
          return
        }
        return this.afterTask(task, context, directory)
      }
      // A web recipe the harness drives itself (WA-7). No model turn, no `ctx.ask` and no session:
      // the action runner executes the recipe in process, and the consent was declared on the run.
      if (task.kind === "action") return this.runActionTask(task, context, directory)
      // Its own tree, when the run asked for it (H-29). Created before the session so everything the
      // task does — its prompt, its answer, its checkpoints, its findings — belongs to it.
      if (run.worktrees && context.options.directory && typeof this.engine.createWorktree === "function") {
        const worktree = await this.engine
          .createWorktree({ directory: context.options.directory, name: worktreeName(task.name) })
          .catch(() => undefined)
        if (worktree) {
          directory = worktree.directory
          this.repository.attachTaskDirectory(task.id, directory)
        }
      }
      // What the run's packs point at, in this task's tree. Artifact refs are said as their
      // content, so a handoff or a verdict is actually read, not just named (HF-6).
      const packs =
        context.packRefsList.length > 0 && directory
          ? packFiles(context.packRefsList, directory)
          : { files: [], others: [] }
      const quoted = expandArtifactRefs(packs.others, (key) => this.artifactQuote(key, run, directory))
      const contextText = quoted.length > 0 ? quoted.join("\n") : undefined
      const contextFiles = packs.files.map((path) => ({ path }))
      // Another vendor's CLI does the work (H-38). It is a process this server holds, so stop and
      // the run's ceiling reach it; it has no session, no model and no tokens the harness can bill.
      if (task.kind === "external") return this.runExternalTask(task, context, directory)
      // What this session is allowed to do (H-47): confined to the project unless the run opened the
      // boundary, and with no shell at all if the run refused it. Both are stated on the run.
      const permission = sessionPermission(run)
      const session = await this.engine.createSession({
        directory,
        parentID: context.parentID,
        title: task.name,
        ...(permission.length > 0 ? { permission } : {}),
      })
      this.repository.attachTaskSession(task.id, session.id)
      await this.engine.prompt({
        sessionID: session.id,
        text: compose(task, handoff, contextText, context.memory),
        directory,
        agent: task.agent,
        // Its own model, or the policy's for the role it runs as (H-30).
        model: modelForTask(task, run.policy),
        ...(contextFiles.length > 0 ? { files: contextFiles } : {}),
      })
      await this.engine.waitForIdle(session.id, {
        directory,
        stopped,
        ...(run.toolLimitMs ? { toolLimitMs: run.toolLimitMs } : {}),
      })
      const answer = await this.engine.lastAnswer(session.id, directory)
      this.repository.finishTask(task.id, stopped() ? "stopped" : "success", {
        output: answer?.text,
        tokens: answer?.tokens,
        cost: answer?.cost,
      })
      context.directories.set(task.id, directory)
      // Over budget: stop and ask, before spending on a closing note that nobody asked for.
      if (this.pauseForBudget(run)) {
        context.pause = "budget"
        return
      }
      // What the next task starts from (H-31): a closing note, not the whole answer. The note is kept
      // as an artifact so the run can be read back, and the raw answer is the fallback when the note
      // cannot be written. A run of a single task has no next task and no thread of its own (see
      // `parentID`), so its closing note would open a session nobody reads: the answer stands as it is.
      const wantsHandoff = tasks.length > 1
      context.handoffs.set(task.id, wantsHandoff ? await this.handoffNote(run, task, answer?.text, directory) : answer?.text)
      // Findings (H-32). Tried after every agent task rather than only after a review: an answer with
      // no parseable block simply has none, and it costs one regular expression. A task that was asked
      // for them and produced none has genuinely found nothing.
      const found = parseFindings(answer?.text)
      if (found.findings.length > 0) {
        this.repository.addFindings(
          found.findings.map((finding) => ({
            ...finding,
            source: "review" as const,
            directory,
            runID: run.id,
            taskID: task.id,
          })),
        )
      }
      return this.afterTask(task, context, directory)
    } catch (cause) {
      this.repository.finishTask(task.id, stopped() ? "stopped" : "failed", { error: message(cause) })
      if (!stopped()) context.failure = message(cause)
    }
  }

  /**
   * A task another vendor's CLI executes (H-38).
   *
   * The command is the workflow's and the boundary is this server's: it runs in the task's tree,
   * what it printed is what the task answered, and a later task is handed it like any other output.
   * Stop and the run's ceiling reach it because it is a child of this process. There is no session
   * and no model, so there are no tokens and no cost to report — the vendor bills that, and the
   * harness does not pretend to know it.
   */
  private async runExternalTask(task: Task, context: RunContext, directory: string | undefined) {
    if (!task.command) {
      const error = "An external task needs a command"
      this.repository.finishTask(task.id, "failed", { error })
      context.failure = error
      return
    }
    const command = externalCommand(task.command, task.prompt)
    const tree = directory ?? process.cwd()
    const live = { tool: command.trim().split(/\s+/)[0] || "external", since: Date.now(), tail: "" }
    externalLive.set(task.id, live)
    try {
      const result = await runExternal({
        command,
        directory: tree,
        stopped: context.stopped,
        ...(context.run.toolLimitMs ? { limitMs: context.run.toolLimitMs } : {}),
        onOutput: (output) => {
          live.tail = output.trimEnd().split("\n").at(-1) ?? ""
        },
      })
      if (result.stopped) {
        this.repository.finishTask(task.id, "stopped", { output: result.output })
        return
      }
      if (result.timedOut) {
        const error = `The external command ran past this run's limit of ${Math.round((context.run.toolLimitMs ?? 0) / 60_000)} minutes for one tool call`
        this.repository.finishTask(task.id, "failed", { output: result.output, error })
        context.failure = error
        return
      }
      if (!result.ok) {
        const error = `The external command exited ${result.exitCode}`
        this.repository.finishTask(task.id, "failed", { output: result.output, error })
        context.failure = error
        return
      }
      this.repository.finishTask(task.id, "success", { output: result.output })
      context.directories.set(task.id, directory)
      // What it printed is what the next task starts from, as with any other answer (H-31).
      context.handoffs.set(task.id, result.output)
      // Findings, when the CLI was asked for them (H-32): an answer with no parseable block simply
      // has none, and it costs one regular expression.
      const found = parseFindings(result.output)
      if (found.findings.length > 0) {
        this.repository.addFindings(
          found.findings.map((finding) => ({
            ...finding,
            source: "review" as const,
            directory: tree,
            runID: context.run.id,
            taskID: task.id,
          })),
        )
      }
      return this.afterTask(task, context, directory)
    } finally {
      externalLive.delete(task.id)
    }
  }

  /**
   * A web action, run by the harness itself (WA-7).
   *
   * The recipe is deterministic and there is no model turn, so the task costs time and no tokens.
   * What makes it safe unattended is the allow rule declared on the run: without one covering the
   * profile, the task fails before any browser opens — an approval nobody can answer must not be
   * asked. Evidence the browser stores is filed under this run and task, and a failure is kept as a
   * log artifact so the run reads back without a transcript. A stop is the run being called off, not
   * a failed recipe, so it does not end the run as a failure.
   */
  private async runActionTask(task: Task, context: RunContext, directory: string | undefined) {
    const spec = task.action
    if (!spec) return this.failAction(task, context, "An action task needs an action", directory)
    const actions = this.actions
    if (!actions) return this.failAction(task, context, "This server has no web actions configured", directory)

    const tree = directory ?? context.options.directory ?? process.cwd()
    // Scope-aware (WA-8): a routine may drive a profile the project's `.opencode` declares, not only
    // a global one.
    const profile = actions.list({ directory: tree }).profiles.find((entry) => entry.id === spec.id)
    if (!profile) return this.failAction(task, context, `No action called "${spec.id}"`, directory)
    // Fail closed before the browser opens: an unattended run cannot answer the approval the
    // interactive path asks, so the consent has to already be on the run (WA-7).
    const missing = missingAllowRules(context.run.allow ?? [], profile)
    if (missing.length > 0)
      return this.failAction(
        task,
        context,
        `This action runs unattended and needs an allow rule for ${missing.map((rule) => rule.pattern).join(", ")}`,
        directory,
      )
    const problem = actionInputProblem(profile, spec.inputs)
    if (problem) return this.failAction(task, context, problem, directory)

    try {
      // Two action runs of the same project collide on its one browser, so give the other run time
      // to finish before the recipe starts rather than failing a task nobody can retry by hand.
      const result = await withBrowserStartRetry(() =>
        actions.run({
          action: profile.id,
          inputs: spec.inputs,
          // Keyed by the task, so the browser and its evidence belong to this run and no other.
          sessionID: task.id,
          project: tree,
          directory: tree,
          runID: context.run.id,
          taskID: task.id,
          stopped: context.stopped,
          closeOnFinish: true,
        }),
      )
      const output = JSON.stringify(result)
      this.repository.finishTask(task.id, context.stopped() ? "stopped" : "success", { output })
      context.directories.set(task.id, directory)
      context.handoffs.set(task.id, output)
      return this.afterTask(task, context, directory)
    } catch (cause) {
      if (isBrowserBusy(cause))
        return this.failAction(
          task,
          context,
          "This project's browser is busy with another action; retry once that run finishes.",
          directory,
        )
      const stopped = cause instanceof ActionRunError && cause.code === "stopped"
      return this.failAction(task, context, message(cause), directory, stopped)
    }
  }

  /** Files an action task's failure, and the log that says what it was (WA-7). */
  private failAction(task: Task, context: RunContext, error: string, directory?: string, stopped = false) {
    this.repository.addArtifact({
      kind: "log",
      title: `${task.name} — ${stopped ? "stopped" : "failed"}`,
      producer: "harness",
      content: error,
      directory,
      runID: context.run.id,
      taskID: task.id,
    })
    this.repository.finishTask(task.id, stopped ? "stopped" : "failed", { error })
    // A stop is the run being called off, not a failure: it must not be thrown, but the run must
    // still close as stopped instead of pretending the work finished.
    if (stopped) context.halted = true
    else context.failure = error
  }

  /**
   * Turns a `foreach` task into one task per step of the plan it names (H-28).
   *
   * The steps share the template's name on purpose: `settled` then means "every step is done", so a
   * task that depends on the template waits for the whole fan-out without knowing it was one. A plan
   * with no readable steps is not a failure — the model may simply not have planned — so the marker
   * says so and nothing is added.
   */
  private expand(task: Task, context: RunContext) {
    const source = this.repository
      .listTasks(context.run.id)
      .filter((entry) => entry.name === task.foreach && entry.status === "success")
      .at(-1)
    const items = parsePlan(source?.output)
    if (items.length === 0) {
      this.repository.finishTask(task.id, "success", { output: `No steps in ${task.foreach}'s plan` })
      return
    }
    this.repository.addTasks(
      context.run.id,
      items.map((item) => ({
        name: task.name,
        prompt: task.prompt.replace(/\{\{\s*item\s*\}\}/g, item),
        kind: task.kind,
        ...(task.agent ? { agent: task.agent } : {}),
        ...(task.model ? { model: task.model } : {}),
        // The command a step runs carries the step too, the same way its prompt does.
        ...(task.command ? { command: task.command.replace(/\{\{\s*item\s*\}\}/g, item) } : {}),
        // A root: it exists because the plan is ready, and it runs alongside its siblings.
        dependsOn: [],
      })),
    )
    this.repository.finishTask(task.id, "success", {
      output: items.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    })
  }

  /**
   * The bookkeeping every finished task shares: a way back from it, and the gate that holds the run.
   *
   * A checkpoint is taken after the task rather than before, so the list reads as "this is what the
   * folder looked like once that step had finished" — the state a reader wants back when the *next*
   * step is the one that went wrong. Failing to record one must not fail the task: the folder may not
   * be a repository at all, and losing finished work over a missing undo would be the worse trade.
   */
  private async afterTask(task: Task, context: RunContext, directory?: string) {
    if (directory) {
      try {
        const checkpoint = await take({
          directory,
          title: task.name,
          // What this step concluded (H-15), so the point reads as more than a sha.
          summary: context.handoffs.get(task.id),
          runID: context.run.id,
          taskID: task.id,
        })
        this.repository.addCheckpoint(checkpoint)
      } catch {
        // Nothing to say here: the run is fine, there is simply no way back from this step.
      }
    }
    // A human gate (H-21): the work is done and nothing else starts until somebody has read it.
    // Whatever is queued stays queued, so letting it through is the same loop, entered again.
    if (task.gate === "human" && !context.stopped()) {
      this.repository.setPaused(context.run.id, "gate")
      context.pause = "gate"
    }
  }
}
