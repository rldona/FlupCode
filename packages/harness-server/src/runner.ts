import { CONFINED, type Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, Task } from "./types"
import { evidenceText, focusedEvidence, runVerify, type VerifyReport } from "./verify"
import { take } from "./checkpoint"
import { parseFindings } from "./findings"
import { packFiles, packRefs } from "./packs"
import { budgetReason, fallbackModel, modelForTask } from "./policy"

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** A run whose verification failed did not succeed, and the reason has to reach the run itself. */
export class VerifyFailed extends Error {
  constructor(summary: string) {
    super(summary)
    this.name = "VerifyFailed"
  }
}

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
 * What a task is handed from the one before it.
 *
 * A handoff, not a transcript (§6.2): tasks receive what the previous one concluded, not its whole
 * conversation. It keeps the prompt small and the dependency explicit — and it is why a task stores
 * its output at all.
 */
function compose(task: Task, handoff: string | undefined, context?: string) {
  const body = !handoff
    ? task.prompt
    : [`Previous step (${handoff.length > 4000 ? "truncated" : "complete"}):`, handoff.slice(0, 4000), "", task.prompt].join(
        "\n",
      )
  if (!context) return body
  return [`Context packs:`, context, "", body].join("\n")
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
 * Runs the tasks of a run, in order.
 *
 * Sequential on purpose: the audit's H-11 is "MVP: secuencial → Future: paralelo", and parallelism
 * needs the write-conflict rules and worktrees of H-29 to be safe. A failed task stops the run and
 * the rest are left as they are, rather than being run against a state nobody verified.
 */
export class TaskRunner {
  constructor(
    private readonly repository: SqliteRoutineRepository,
    private readonly engine: Engine,
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
    const executor = this.repository
      .listTasks(run.id)
      .filter((entry) => entry.kind === "agent" && entry.position < verify.position)
      .at(-1)
    if (!executor) return false
    this.repository.addTasks(run.id, [
      {
        name: executor.name,
        prompt: retryPrompt(executor, evidence),
        kind: "agent",
        agent: executor.agent,
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
   * Runs what is queued, and says why it stopped.
   *
   * `paused` is a run that reached a human gate and is waiting to be let through — not an ending,
   * which is why it is a return value and not an exception like a failure is.
   */
  async execute(run: Run, options: { directory?: string; stopped?: () => boolean } = {}): Promise<"done" | "paused"> {
    const stopped = options.stopped ?? (() => false)
    const tasks = this.repository.listTasks(run.id).filter((task) => task.status === "queued")
    const nextQueued = () => this.repository.listTasks(run.id).find((entry) => entry.status === "queued")
    // The run's own session is the thread a person reads; each task is a child of it, which is the
    // lineage the engine already keeps. A run of one task needs no thread of its own, and creating
    // one would leave an empty session in everybody's list.
    // Re-read: the run gained its session after it was started, when the caller decided the work
    // needed a thread of its own.
    const parentID = tasks.length > 1 ? (this.repository.getRun(run.id)?.sessionID ?? run.sessionID) : undefined
    // The run's context packs (H-31), as refs. Which of them are files depends on the tree the task
    // runs in, and with worktrees (H-29) that is the task's, not the run's.
    const packRefsList =
      run.packs && run.packs.length > 0 && options.directory
        ? packRefs(this.repository.listPacks(options.directory), run.packs)
        : []
    // Where a verify task checks: the tree of the task it is checking. The primary checkout unless
    // that task was isolated in a worktree.
    let executorDirectory = options.directory
    let handoff: string | undefined

    for (let task = nextQueued(); task; task = nextQueued()) {
      if (stopped()) {
        this.repository.finishTask(task.id, "stopped", { error: "The run was stopped" })
        continue
      }
      this.repository.startTask(task.id, Date.now())
      // A verify task runs the project's own commands and keeps what they printed (H-22). No
      // session and no model: it costs time, not tokens, which is what makes it worth running after
      // every attempt rather than once at the end.
      if (task.kind === "verify") {
        // The tree the step it checks ran in (H-29): a worktree task is verified in its own worktree,
        // or the verdict would be about code nobody changed.
        const report = await runVerify(executorDirectory ?? process.cwd(), { stopped })
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
          directory: executorDirectory,
          runID: run.id,
          taskID: task.id,
        })
        // Every failure the checks named, anchored on its line (H-22, and the structured output
        // H-21 asks of this gate). They are findings like a review's, which means they are drawn on
        // the diff by the machinery H-32 already built: a broken test lands on the line that broke.
        this.recordFailures(report, run.id, task.id, executorDirectory)
        // The checks cost time, not tokens, but the run they belong to may already be over budget.
        if (this.pauseForBudget(run)) return "paused"
        // The evidence is the handoff: whatever runs next is told exactly what failed.
        handoff = evidence
        if (!report.ok && !stopped()) {
          // A failed check is not the end of the run if it was given a budget to try again. The
          // retry carries the evidence in its own prompt, so the handoff is cleared, not repeated.
          // It is handed the parsed failures rather than the log: the same information, without the
          // stack traces, paid for on every attempt.
          if (this.scheduleRetry(run, task, focusedEvidence(report))) {
            handoff = undefined
            continue
          }
          throw new VerifyFailed(failureSummary(report))
        }
      } else {
        try {
          // Its own tree, when the run asked for it (H-29). Created before the session so everything
          // the task does — its prompt, its answer, its checkpoints, its findings — belongs to it.
          let taskDirectory = options.directory
          if (run.worktrees && options.directory && typeof this.engine.createWorktree === "function") {
            const worktree = await this.engine
              .createWorktree({ directory: options.directory, name: worktreeName(task.name) })
              .catch(() => undefined)
            if (worktree) {
              taskDirectory = worktree.directory
              this.repository.attachTaskDirectory(task.id, taskDirectory)
            }
          }
          // What the run's packs point at, in this task's tree.
          const packs =
            packRefsList.length > 0 && taskDirectory
              ? packFiles(packRefsList, taskDirectory)
              : { files: [], others: [] }
          const context = packs.others.length > 0 ? packs.others.join("\n") : undefined
          const contextFiles = packs.files.map((path) => ({ path }))
          const session = await this.engine.createSession({
            directory: taskDirectory,
            parentID,
            title: task.name,
            // Confined to the project unless this run said otherwise (H-47). The harness has always
            // passed `directory` to the engine; passing it only says where to start, not where to
            // stop, and an unattended task could walk the disk from there.
            ...(run.outside ? {} : { permission: CONFINED }),
          })
          this.repository.attachTaskSession(task.id, session.id)
          await this.engine.prompt({
            sessionID: session.id,
            text: compose(task, handoff, context),
            directory: taskDirectory,
            agent: task.agent,
            // Its own model, or the policy's for the role it runs as (H-30).
            model: modelForTask(task, run.policy),
            ...(contextFiles.length > 0 ? { files: contextFiles } : {}),
          })
          await this.engine.waitForIdle(session.id, {
            directory: taskDirectory,
            stopped,
            ...(run.toolLimitMs ? { toolLimitMs: run.toolLimitMs } : {}),
          })
          const answer = await this.engine.lastAnswer(session.id, taskDirectory)
          this.repository.finishTask(task.id, stopped() ? "stopped" : "success", {
            output: answer?.text,
            tokens: answer?.tokens,
            cost: answer?.cost,
          })
          // Over budget: stop and ask, before spending on a closing note that nobody asked for.
          if (this.pauseForBudget(run)) return "paused"
          // The next task, especially a verify, looks at this task's tree, not the run's folder.
          executorDirectory = taskDirectory
          // What the next task starts from (H-31): a closing note, not the whole answer. The note is
          // kept as an artifact so the run can be read back, and the raw answer is the fallback when
          // the note cannot be written.
          handoff = await this.handoffNote(run, task, answer?.text, taskDirectory)
          // Findings (H-32). Tried after every agent task rather than only after a review: an
          // answer with no parseable block simply has none, and it costs one regular expression.
          // A task that was asked for them and produced none has genuinely found nothing.
          const found = parseFindings(answer?.text)
          if (found.findings.length > 0) {
            this.repository.addFindings(
              found.findings.map((finding) => ({
                ...finding,
                source: "review" as const,
                directory: taskDirectory,
                runID: run.id,
                taskID: task.id,
              })),
            )
          }
        } catch (cause) {
          this.repository.finishTask(task.id, stopped() ? "stopped" : "failed", { error: message(cause) })
          throw cause
        }
      }
      // A way back from this task (H-15). After it rather than before, so the list reads as "this is
      // what the folder looked like once that step had finished" — which is the state a reader
      // wants back when the *next* step is the one that went wrong.
      //
      // Failing to record one must not fail the task. The folder may not be a repository at all,
      // and losing a finished piece of work over a missing undo would be the worse trade.
      if (executorDirectory) {
        try {
          const checkpoint = await take({
            // The task's own tree (H-29), so the point is about what that task changed.
            directory: executorDirectory,
            title: task.name,
            // What this step concluded (H-15), so the point reads as more than a sha.
            summary: handoff,
            runID: run.id,
            taskID: task.id,
          })
          this.repository.addCheckpoint(checkpoint)
        } catch {
          // Nothing to say here: the run is fine, there is simply no way back from this step.
        }
      }
      // A human gate (H-21): the work is done and nothing else starts until somebody has read it.
      // Whatever is queued stays queued, so letting it through is the same loop, entered again.
      if (task.gate === "human" && !stopped()) {
        this.repository.setPaused(run.id, "gate")
        return "paused"
      }
    }
    return "done"
  }
}
