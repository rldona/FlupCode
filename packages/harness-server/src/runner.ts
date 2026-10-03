import { NeedsPerson, sessionPermission, type Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, Task, TaskStatus, TaskVerdict, Artifact, Unattended } from "./types"
import type { EpisodeCoordinator } from "./adaptive/coordinator"
import { evidenceText, focusedEvidence, runVerify, type VerifyReport } from "./verify"
import { previewEvidence, type PreviewCapture } from "./browser-preview"
import { externalCommand, fillCommand, runExternal } from "./external"
import { take, type Checkpoint } from "./checkpoint"
import { parseFindings } from "./findings"
import { packFiles, packRefs, expandArtifactRefs } from "./packs"
import { parsePlan } from "./plan"
import { fallbackModel, modelForTask } from "./policy"
import { announce, hardReason, runStandings } from "./budget"
import { ActionRunError } from "./action-runner"
import type { ActionRunner } from "./action-runner"
import { BrowserError } from "./browser-driver"
import { actionInputProblem, missingAllowRules } from "./action-allow"
import { profileTier } from "./browser-policy"
import type { ContextManager } from "./adaptive/context-manager"
import type { ContextPart } from "./adaptive/context"
import { answerVerdict, auditedVerdict, type Auditor } from "./verdict"

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

const passSummary = (report: { steps: Array<{ name: string }> }) =>
  `Verification passed: ${report.steps.map((step) => step.name).join(", ")}`

const failureSummary = (report: { steps: Array<{ name: string; exitCode: number }>; problem?: string }) => {
  // A declaration that cannot be read is its own answer, and the one the reader can act on.
  if (report.problem) return `Verification could not run: ${report.problem}`
  const failed = report.steps.filter((step) => step.exitCode !== 0).map((step) => step.name)
  if (failed.length === 0) return "Nothing to verify: the project declares no verify steps"
  return `Verification failed: ${failed.join(", ")}`
}

/**
 * The parts a run prompt is assembled from, before anything selects among them (FH-024).
 *
 * A part is a whole block of the assembly — the memory notes, one artifact quote, one file the
 * engine reads, the handoff of the tasks before, the task's own instruction. The planner decides
 * about them and the renderer joins them, so a selection ever removes a whole part and never
 * rewrites one. The ids are positional and carry no path, command or text: the plan audit is
 * content-free by construction, and `packs.ts` stays pure.
 */
export type RunPromptPartsInput = {
  objective: string
  handoff?: string | undefined
  /** The artifact refs said as their content, in order (`expandArtifactRefs`). */
  artifacts?: readonly string[]
  /** The project's notes, already joined (`RunContext.memory`). */
  memory?: string | undefined
  files?: readonly { path: string }[]
}

export function runPromptParts(input: RunPromptPartsInput): ContextPart[] {
  return [
    ...(input.memory ? [{ id: "memory", kind: "memory" as const, text: input.memory }] : []),
    ...(input.artifacts ?? []).map((text, index) => ({ id: `artifact:${index}`, kind: "artifact" as const, text })),
    ...(input.files ?? []).map((file, index) => ({ id: `file:${index}`, kind: "file" as const, file })),
    ...(input.handoff ? [{ id: "handoff", kind: "handoff" as const, text: input.handoff }] : []),
    { id: "objective", kind: "objective" as const, text: input.objective },
  ]
}

/**
 * The one renderer of a run prompt.
 *
 * Memory and packs come first, then the handoff and the task's own instruction. Both the selection
 * path (parts filtered by the plan) and the plain path (parts untouched) go through here, so turning
 * selection off is byte-identical by construction rather than by a second implementation agreeing.
 */
export function renderRunPrompt(parts: readonly ContextPart[]): { text: string; files: Array<{ path: string }> } {
  // A header is turned on by the **joined** text, not by each part: this is exactly the truthiness
  // the pre-selection `compose` applied to `quoted.join("\n")`, so a mixture like `["", "@artifact:x"]`
  // keeps the blank line the historical join produced and stays byte-identical.
  const memory = parts
    .filter((part) => part.kind === "memory")
    .map((part) => part.text ?? "")
    .join("\n")
  const artifacts = parts
    .filter((part) => part.kind === "artifact")
    .map((part) => part.text ?? "")
    .join("\n")
  const files = parts.flatMap((part) => (part.file ? [part.file] : []))
  const handoff = parts.find((part) => part.kind === "handoff")?.text
  const objective = parts.find((part) => part.kind === "objective")?.text ?? ""

  const head = [
    memory ? `Project memory:\n${memory}` : "",
    artifacts ? `Context packs:\n${artifacts}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const body = !handoff
    ? objective
    : [
        `Previous step (${handoff.length > 4000 ? "truncated" : "complete"}):`,
        handoff.slice(0, 4000),
        "",
        objective,
      ].join("\n")

  return { text: !head ? body : [`${head}`, "", body].join("\n"), files }
}

/**
 * What a task is handed from the ones before it.
 *
 * A handoff, not a transcript (§6.2): tasks receive what their dependencies concluded, not whole
 * conversations. It keeps the prompt small and the dependency explicit — and it is why a task stores
 * its output at all. With a graph a task may have several (H-28), so they are joined. It builds the
 * parts and delegates to the one renderer, so it can never drift from the selection path.
 */
export function compose(task: Task, handoff: string | undefined, context?: string, memory?: string) {
  return renderRunPrompt(
    runPromptParts({
      objective: task.prompt,
      ...(handoff ? { handoff } : {}),
      ...(context ? { artifacts: [context] } : {}),
      ...(memory ? { memory } : {}),
    }),
  ).text
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

/**
 * The tasks a task waits for, by name.
 *
 * An explicit `dependsOn` — including an empty one, which is what `parallel: true` becomes — is
 * used as written. A task that says nothing follows the one above it, which is the v1 rule. A
 * `when` names a task whose outcome decides this one, so it is waited for whether or not it was
 * listed.
 */
function dependencies(task: Task, tasks: Task[]): string[] {
  const explicit = task.foreach
    ? [task.foreach]
    : task.dependsOn !== undefined
      ? task.dependsOn
      : task.retryOf
        ? // A retry somebody asked for (H-12) works from what the original was given (TI-03).
          (() => {
            const original = tasks.find((entry) => entry.id === task.retryOf)
            return original ? dependencies(original, tasks) : []
          })()
        : (() => {
            const previous = tasks.filter((entry) => entry.position < task.position).at(-1)
            return previous ? [previous.name] : []
          })()
  const condition = task.when?.task
  return condition && !explicit.includes(condition) ? [...explicit, condition] : explicit
}

/** What a task is waiting for, and what lets it run. */
type Decision = { action: "run" } | { action: "wait" } | { action: "skip"; reason: string }

/**
 * How a run is driven: its folder, whether it was stopped, and which budget the scheduler stopped it
 * at mid-step (UL-08), if one.
 */
export type RunOptions = { directory?: string; stopped?: () => boolean; overBudget?: () => string | undefined }

type RunContext = {
  run: Run
  options: RunOptions
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
  /** The tasks whose session waits on a person right now (RP-05); the run is held while any does. */
  waiting: Set<string>
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
    /**
     * Where a run's episode is captured (FH-002).
     *
     * Absent means this runner records none, which is what its own tests and a build without the
     * adaptive layer want: the detection must never change how a run behaves.
     */
    private readonly episodes?: EpisodeCoordinator,
    /**
     * Where a run prompt's context is planned and, opt-in, selected among (FH-024).
     *
     * Absent means this runner selects nothing and renders exactly as before. When present, the plan
     * is best-effort — a failure to plan never fails the run — and it only filters whole parts when
     * `context.apply` is on, which is off by default.
     */
    private readonly context?: ContextManager,
    /**
     * The auditor model's judgement of a finished agent task (RP-06), through the decision service.
     *
     * Absent means the deterministic rule alone judges, which is also what happens when no model is
     * assigned to `completion`. A failure to audit never fails the task: the rule's verdict stands.
     */
    private readonly auditor?: Auditor,
    /**
     * A verify task's picture of the project's page in the desktop's preview (BU-06).
     *
     * Absent means this server has no preview, and a verify task captures nothing.
     */
    private readonly previewCapture?: PreviewCapture,
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
    const executor = this.checkedTask(run, verify)
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
   * The agent task a check is about: the one it names, when it says so; a v1 check has no
   * `dependsOn`, so the nearest agent task before it is the work it was checking.
   */
  private checkedTask(run: Run, verify: Task) {
    const agents = this.repository.listTasks(run.id).filter((entry) => entry.kind === "agent")
    return (
      verify.dependsOn && verify.dependsOn.length > 0
        ? agents.filter((entry) => verify.dependsOn!.includes(entry.name))
        : agents.filter((entry) => entry.position < verify.position)
    ).at(-1)
  }

  /**
   * Judges a finished agent task (RP-06): the rule over its final answer, then the auditor model when
   * one is assigned, and keeps the verdict on the task and as a `verdict` artifact so the run can be
   * read back without its transcripts.
   */
  private async judge(run: Run, task: Task, answer: string | undefined, directory?: string) {
    const baseline = answerVerdict(answer)
    const audit =
      this.auditor && answer?.trim()
        ? await this.auditor({
            runID: run.id,
            taskID: task.id,
            objective: task.prompt,
            answer,
            ...(directory ? { projectID: directory } : {}),
          }).catch(() => undefined)
        : undefined
    this.recordVerdict(run, task, auditedVerdict(baseline, audit), directory)
  }

  /** A task's verdict, on the task and as a `verdict` artifact: a later one is kept beside it, not over it. */
  private recordVerdict(run: Run, task: Task, verdict: TaskVerdict, directory?: string) {
    this.repository.setTaskVerdict(task.id, verdict)
    this.repository.addArtifact({
      kind: "verdict",
      title: `${task.name} — ${verdict.value}`,
      producer: "harness",
      content: verdict.reason,
      directory,
      runID: run.id,
      taskID: task.id,
    })
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
   * Whether the run has reached a budget, and should stop and ask (H-30, UL-08).
   *
   * Read from the usage ledger, the run's own budget and every standing one that covers it, so what
   * a task spent mid-turn, its subagents and its closing notes all count. The scheduler stops a turn
   * at the step that crosses (`overBudget`); this is the same rule at the edges of a task, and before
   * the first one, so a run that starts over a spent day budget spends nothing. A run somebody let
   * past its budget is not asked again.
   */
  private pauseForBudget(run: Run, context: RunContext) {
    if (context.pause === "budget") return true
    if (run.budgetApproved) return false
    const halted = context.options.overBudget?.()
    const standings = halted ? [] : runStandings(this.repository, run)
    const reason = halted ?? hardReason(standings)
    if (!reason) return false
    const crossed = standings.find((entry) => entry.level === "hard")
    if (crossed) announce(this.repository, crossed, { runID: run.id, ...(run.sessionID ? { sessionID: run.sessionID } : {}) })
    this.repository.setPaused(run.id, "budget", reason)
    context.pause = "budget"
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
      const note = await this.engine.handoff({
        directory,
        task: task.name,
        answer,
        // The note's session is the run's too, labelled as what it is (UL-04).
        onSession: (sessionID) =>
          this.repository.attributeSession(sessionID, { runID: run.id, taskID: task.id, purpose: "handoff" }),
      })
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
   * What a wait on a person does in this run (RP-05): what the run declares, else its project's
   * default, else `gate`, which is the closest to what an unattended task did before it existed — wait
   * for somebody — but visible on the run and without the thirty-minute cap.
   */
  private unattended(run: Run, context: RunContext): Unattended {
    const project = context.options.directory ?? run.directory
    return run.policy?.unattended ?? (project ? this.repository.projectUnattended(project) : undefined) ?? "gate"
  }

  /** Holds the run while any of its tasks waits on a person, and lets it go when none does (RP-05). */
  private waitingOnPerson(context: RunContext, task: Task, waiting: boolean) {
    const before = context.waiting.size
    if (waiting) context.waiting.add(task.id)
    if (!waiting) context.waiting.delete(task.id)
    if (before === 0 && context.waiting.size > 0) this.repository.holdForRequest(context.run.id)
    if (before > 0 && context.waiting.size === 0) this.repository.releaseRequest(context.run.id)
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
    for (const name of dependencies(task, tasks)) {
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
    // `require: verified` (RP-06): the work before this task has to have been checked, not only to
    // have ended. The newest attempt of each dependency is the one that speaks for it.
    if (task.require === "verified") {
      const unverified = dependencies(task, tasks).find(
        (name) => tasks.filter((entry) => entry.name === name).at(-1)?.verdict?.value !== "verified",
      )
      if (unverified) return { action: "skip", reason: `Not run: ${unverified} was not verified` }
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

  /**
   * What the finished tasks handed on, read back from the database (TI-03).
   *
   * A run is driven again after a gate, a budget stop, a restart or a retry, and every time by a new
   * `runGraph`: without this, a task behind the pause would start with no note and in the run's
   * folder instead of the tree its predecessor worked in. The note is the handoff artifact the task
   * left, or its output when it wrote none (a check's evidence, a command's output, a short answer).
   * A tree is the one the task recorded; one that recorded none worked where its predecessors left
   * it, worked out in order exactly as it was the first time.
   */
  private rehydrate(run: Run, tasks: Task[], context: RunContext) {
    const notes = new Map(
      this.repository
        .listArtifacts({ runID: run.id, kind: "handoff" })
        .flatMap((artifact) => (artifact.taskID ? [[artifact.taskID, artifact.content] as const] : [])),
    )
    for (const task of tasks.filter((entry) => entry.status === "success")) {
      context.handoffs.set(task.id, notes.get(task.id) ?? task.output)
      context.directories.set(task.id, task.directory ?? this.directoryFor(task, tasks, context))
    }
  }

  /** What the tasks before it concluded, joined: a graph task may have several (H-28). */
  private handoffFor(task: Task, tasks: Task[], context: RunContext) {
    const notes = dependencies(task, tasks)
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
    const deps = dependencies(task, tasks).filter((name) => name !== task.when?.task)
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
  async execute(
    run: Run,
    options: RunOptions = {},
  ): Promise<"done" | "paused" | "stopped"> {
    try {
      return await this.runGraph(run, options)
    } finally {
      // The run's boundary, wherever `execute` returned from: the caller (the scheduler) also
      // captures after `finishRun`, and both converge on the same row.
      this.episodes?.captureRun(run.id)
    }
  }

  private async runGraph(
    run: Run,
    options: RunOptions = {},
  ): Promise<"done" | "paused" | "stopped"> {
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
      waiting: new Set(),
    }
    this.rehydrate(run, all, context)
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
      // A budget reached by the work in flight, or before the first task (UL-08): nothing new starts.
      if (queued.length > 0) this.pauseForBudget(run, context)
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
        // Evidence, not a check: the page the project names, as the preview showed it after the checks.
        const preview = stopped()
          ? undefined
          : await this.previewCapture?.({ directory: directory ?? process.cwd(), runID: run.id, taskID: task.id, name: task.name })
        const evidence = previewEvidence(evidenceText(report), preview)
        this.repository.finishTask(task.id, stopped() ? "stopped" : report.ok ? "success" : "failed", {
          output: evidence,
          error: report.ok ? undefined : failureSummary(report),
        })
        // A check that ran is the one thing that makes work `verified` (RP-06): the check itself, and
        // the agent task it checked, unless that task already said it did not finish — a passing suite
        // does not turn "I stop here" into done. A failed check fails the work it checked.
        if (!stopped()) {
          const verdict = report.ok
            ? { value: "verified" as const, reason: passSummary(report), source: "check" as const }
            : { value: "failed" as const, reason: failureSummary(report), source: "check" as const }
          this.repository.setTaskVerdict(task.id, verdict)
          const checked = this.checkedTask(run, task)
          const standing = checked?.verdict?.value
          if (checked && (!report.ok || standing === undefined || standing === "unverified"))
            this.recordVerdict(run, checked, verdict, checked.directory ?? directory)
        }
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
        if (this.pauseForBudget(run, context)) return
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
      const contextFiles = packs.files.map((path) => ({ path }))
      // Another vendor's CLI does the work (H-38). It is a process this server holds, so stop and
      // the run's ceiling reach it; it has no session, no model and no tokens the harness can bill.
      if (task.kind === "external") return this.runExternalTask(task, context, directory)
      // What this session is allowed to do (H-47): confined to the project unless the run opened the
      // boundary, and with no shell at all if the run refused it. Both are stated on the run.
      const permission = sessionPermission(run)
      // A session created while a project's MCP server is still connecting starts without that
      // server's tools, and the run would work against a smaller project than the one configured.
      // An engine too old to expose `ensureMcp` is left alone rather than failing over a capability
      // it lacks, the same way `createWorktree` is guarded above.
      if (directory && typeof this.engine.ensureMcp === "function") await this.engine.ensureMcp(directory)
      const session = await this.engine.createSession({
        directory,
        parentID: context.parentID,
        title: task.name,
        ...(permission.length > 0 ? { permission } : {}),
      })
      this.repository.attachTaskSession(task.id, session.id)
      // The assembly, as whole parts (FH-024). Planning is best-effort: it never fails the run, and
      // applying is opt-in (`context.apply`, off by default), so the prompt below is byte-identical
      // to the one before selection existed until an install turns it on.
      const parts = runPromptParts({
        objective: task.prompt,
        ...(handoff ? { handoff } : {}),
        ...(quoted.length > 0 ? { artifacts: quoted } : {}),
        ...(context.memory ? { memory: context.memory } : {}),
        ...(contextFiles.length > 0 ? { files: contextFiles } : {}),
      })
      const plan = this.context
        ? await this.context
            .plan({
              parts,
              objective: task.prompt,
              runID: run.id,
              taskID: task.id,
              sessionID: session.id,
              ...(directory ? { projectID: directory } : {}),
            })
            .catch(() => undefined)
        : undefined
      const active = this.context ? this.context.apply({ parts, plan }) : parts
      // The audit distinguishes shadow from acting: a plan is `applied` only when it actually
      // removed a part. `apply` never adds, so a shorter assembly means it filtered something.
      if (this.context && plan && active.length !== parts.length) this.context.markApplied(plan.id)
      const { text, files } = renderRunPrompt(active)
      await this.engine.prompt({
        sessionID: session.id,
        text,
        directory,
        agent: task.agent,
        // Its own model, or the policy's for the role it runs as (H-30).
        model: modelForTask(task, run.policy),
        ...(files.length > 0 ? { files } : {}),
      })
      // Nobody is in this session to answer a permission or a question (RP-05): the run says what a
      // wait on a person does — fail the task with it, or hold the run until it is answered.
      try {
        await this.engine.waitForIdle(session.id, {
          // A budget the scheduler saw crossed stops the turn the way Stop does (TI-01).
          stopped: () => stopped() || !!context.options.overBudget?.(),
          ...(run.toolLimitMs ? { toolLimitMs: run.toolLimitMs } : {}),
          unattended: this.unattended(run, context),
          ...(directory ? { directory } : {}),
          onWaiting: (request) => this.waitingOnPerson(context, task, !!request),
        })
      } finally {
        this.waitingOnPerson(context, task, false)
      }
      // The session went quiet: that is the boundary FH-002 captures. It carries the run's id, so a
      // task's session never becomes an episode of its own.
      this.episodes?.captureSession({ sessionID: session.id, runID: run.id, directory })
      const answer = await this.engine.lastAnswer(session.id)
      // Stopped at the step that crossed a budget (UL-08): the task failed for it, and the run waits at
      // the budget gate, where carrying on does this task again.
      const overBudget = stopped() ? undefined : context.options.overBudget?.()
      if (overBudget) {
        this.repository.finishTask(task.id, "failed", {
          output: answer?.text,
          error: overBudget,
          tokens: answer?.tokens,
          cost: answer?.cost,
        })
        this.repository.setTaskVerdict(task.id, { value: "failed", reason: overBudget, source: "rule" })
        // The folder as the stopped turn left it, possibly mid-edit: kept as a way back to that work,
        // never as what a resume restores (that is the last task that succeeded).
        if (directory)
          await take({ directory, title: `${task.name} — stopped at its budget`, summary: overBudget, runID: run.id, taskID: task.id })
            .then((checkpoint) => this.repository.addCheckpoint(checkpoint))
            .catch(() => undefined)
        this.pauseForBudget(run, context)
        return
      }
      // A quiet session is not a successful one (TI-02): a refused or empty turn fails the task, with
      // what the engine said as its error and what it spent kept all the same.
      const failure = stopped() ? undefined : answer?.error
      this.repository.finishTask(task.id, stopped() ? "stopped" : failure ? "failed" : "success", {
        output: answer?.text,
        ...(failure ? { error: failure } : {}),
        tokens: answer?.tokens,
        cost: answer?.cost,
      })
      if (failure) {
        this.repository.setTaskVerdict(task.id, { value: "failed", reason: failure, source: "rule" })
        context.failure = failure
        return
      }
      if (!stopped()) await this.judge(run, task, answer?.text, directory)
      context.directories.set(task.id, directory)
      // A stopped run has no next task to hand anything to, and a closing note is a turn of its own.
      if (stopped()) return
      // Over budget: stop and ask, before spending on a closing note that nobody asked for.
      if (this.pauseForBudget(run, context)) return
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
      // A turn cut short by a timeout or a tool ceiling still spent something; it is kept (TI-02).
      const sessionID = this.repository.getTask(task.id)?.sessionID
      const spent = sessionID ? await this.engine.lastAnswer(sessionID).catch(() => undefined) : undefined
      this.repository.finishTask(task.id, stopped() ? "stopped" : "failed", {
        error: message(cause),
        tokens: spent?.tokens,
        cost: spent?.cost,
      })
      if (stopped()) return
      // A task that failed is judged as failed (RP-06), so the run's verdict is never better than it.
      // One failed for needing a person nobody was there to be (RP-05) needs the user: what it asked
      // is the reason, and only somebody can answer it, here or by letting the project wait for them.
      if (task.kind === "agent" || task.kind === "verify")
        this.repository.setTaskVerdict(task.id, {
          value: cause instanceof NeedsPerson ? "needs-user" : "failed",
          reason: message(cause),
          source: "rule",
        })
      context.failure = message(cause)
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
    // interactive path asks, so the browser policy has to allow it as it stands, which for a routine
    // means the consent written on the run (WA-7, BU-01).
    const question = {
      origin: profile.origin,
      tier: profileTier(profile),
      runId: context.run.id,
      taskId: task.id,
      action: profile.id,
      rules: context.run.allow ?? [],
    }
    const verdict = actions.policy.decide(question)
    if (verdict.decision === "deny") return this.failAction(task, context, verdict.reason, directory)
    if (!verdict.permit)
      return this.failAction(
        task,
        context,
        `This action runs unattended and needs an allow rule for ${missingAllowRules(context.run.allow ?? [], profile)
          .map((rule) => rule.pattern)
          .join(", ")}`,
        directory,
      )
    const problem = actionInputProblem(profile, spec.inputs)
    if (problem) return this.failAction(task, context, problem, directory)

    try {
      // Two action runs of the same project collide on its one browser, so give the other run time
      // to finish before the recipe starts rather than failing a task nobody can retry by hand.
      // A permit is spent by the attempt that presents it, so a retry after a busy browser asks again.
      const permits = [verdict.permit]
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
          permit: permits.pop() ?? actions.policy.decide(question).permit,
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
        // Quoted: the step is a model's text, and the command is shell (TI-06).
        ...(task.command ? { command: fillCommand(task.command, { item }) } : {}),
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

/**
 * Where a run picks up again (RP-04), and what it runs.
 *
 * Only what has not succeeded runs: the task it resumes from — the one named, or else every task
 * that failed or was stopped — and whatever behind it was failed, stopped or skipped because of it.
 * Each is put back as a new attempt rather than the same row run twice, for the reason a retry is
 * (H-12): the failed attempt keeps what it did, said and cost, and the run's verdict reads the newest
 * attempt (RP-06). Work that never started stays queued and waits for them; succeeded tasks are not
 * touched, so their output, cost and checkpoints stay.
 *
 * The folder goes back to the newest checkpoint of a task that stays succeeded, which is how it
 * looked before the task it resumes from began — the run then behaves as if it had never stopped. A
 * task an interrupted process left queued counts as where it broke. There is nothing to go back to
 * before the first task (no point was taken), nor in a run of worktrees, where every attempt starts
 * a tree of its own.
 */
export function resumePoint(run: Run, tasks: Task[], checkpoints: Checkpoint[], fromTask?: string) {
  const superseded = new Set(tasks.flatMap((task) => (task.retryOf ? [task.retryOf] : [])))
  const standing = tasks.filter((task) => !superseded.has(task.id))
  const starts = fromTask
    ? [startingTask(standing, tasks, fromTask)]
    : standing.filter((task) => task.status === "failed" || task.status === "stopped")
  const again = behind(starts, standing, tasks)
  const from = [...starts, ...standing.filter((task) => task.status === "queued" && task.startedAt !== undefined)]
    .sort((a, b) => a.position - b.position)
    .at(0)
  const kept = new Set(standing.filter((task) => task.status === "success").map((task) => task.id))
  const checkpoint =
    from && !run.worktrees ? checkpoints.find((point) => point.taskID && kept.has(point.taskID)) : undefined
  return {
    again,
    /** Everything that will run, in order: the new attempts and the work that was still queued. */
    runs: [...again, ...standing.filter((task) => task.status === "queued")].sort((a, b) => a.position - b.position),
    checkpoint,
  }
}

/** The task a reader chose to resume from: the newest attempt of its name, and one that did not succeed. */
function startingTask(standing: Task[], tasks: Task[], taskID: string) {
  const task = standing.find((entry) => entry.id === taskID)
  if (!task && tasks.some((entry) => entry.id === taskID))
    throw new Error("A newer attempt of this task exists; resume from that one")
  if (!task) throw new Error("This task is not part of the run")
  if (task.status !== "failed" && task.status !== "stopped" && task.status !== "skipped")
    throw new Error("Only a task that failed, was stopped or was skipped can be resumed from")
  return task
}

/** The starting tasks and every settled, unsucceeded task that waits on them, however far down. */
function behind(starts: Task[], standing: Task[], tasks: Task[]) {
  const again = new Map(starts.map((task) => [task.id, task]))
  const grow = (): Task[] => {
    const names = new Set([...again.values()].map((task) => task.name))
    const next = standing.filter(
      (task) =>
        !again.has(task.id) &&
        (task.status === "failed" || task.status === "stopped" || task.status === "skipped") &&
        dependencies(task, tasks).some((name) => names.has(name)),
    )
    if (next.length === 0) return [...again.values()].sort((a, b) => a.position - b.position)
    for (const task of next) again.set(task.id, task)
    return grow()
  }
  return grow()
}
