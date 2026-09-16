import type { Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, Task } from "./types"
import { evidenceText, runVerify } from "./verify"

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

const failureSummary = (steps: Array<{ name: string; exitCode: number }>) => {
  const failed = steps.filter((step) => step.exitCode !== 0).map((step) => step.name)
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
function compose(task: Task, handoff: string | undefined) {
  if (!handoff) return task.prompt
  return [
    `Previous step (${handoff.length > 4000 ? "truncated" : "complete"}):`,
    handoff.slice(0, 4000),
    "",
    task.prompt,
  ].join("\n")
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
  private scheduleRetry(runID: string, verify: Task, evidence: string) {
    const budget = verify.retries ?? 0
    if (budget <= 0) return false
    const executor = this.repository
      .listTasks(runID)
      .filter((entry) => entry.kind === "agent" && entry.position < verify.position)
      .at(-1)
    if (!executor) return false
    this.repository.addTasks(runID, [
      {
        name: executor.name,
        prompt: retryPrompt(executor, evidence),
        kind: "agent",
        agent: executor.agent,
        model: executor.model,
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
        const report = await runVerify(options.directory ?? process.cwd(), { stopped })
        const evidence = evidenceText(report)
        this.repository.finishTask(task.id, stopped() ? "stopped" : report.ok ? "success" : "failed", {
          output: evidence,
          error: report.ok ? undefined : failureSummary(report.steps),
        })
        // And it is kept (H-14): the verdict of a check is the evidence the audit asks for, and it
        // outlives the task list, which only shows the last twenty runs.
        this.repository.addArtifact({
          kind: "verdict",
          title: `${task.name} — ${report.ok ? "passed" : "failed"}`,
          producer: "harness",
          content: evidence,
          directory: options.directory,
          runID: run.id,
          taskID: task.id,
        })
        // The evidence is the handoff: whatever runs next is told exactly what failed.
        handoff = evidence
        if (!report.ok && !stopped()) {
          // A failed check is not the end of the run if it was given a budget to try again. The
          // retry carries the evidence in its own prompt, so the handoff is cleared, not repeated.
          if (this.scheduleRetry(run.id, task, evidence)) {
            handoff = undefined
            continue
          }
          throw new VerifyFailed(failureSummary(report.steps))
        }
      } else {
        try {
          const session = await this.engine.createSession({
            directory: options.directory,
            parentID,
            title: task.name,
          })
          this.repository.attachTaskSession(task.id, session.id)
          await this.engine.prompt({
            sessionID: session.id,
            text: compose(task, handoff),
            directory: options.directory,
            agent: task.agent,
            model: task.model,
          })
          await this.engine.waitForIdle(session.id, { directory: options.directory, stopped })
          const answer = await this.engine.lastAnswer(session.id, options.directory)
          this.repository.finishTask(task.id, stopped() ? "stopped" : "success", {
            output: answer?.text,
            tokens: answer?.tokens,
            cost: answer?.cost,
          })
          handoff = answer?.text
        } catch (cause) {
          this.repository.finishTask(task.id, stopped() ? "stopped" : "failed", { error: message(cause) })
          throw cause
        }
      }
      // A human gate (H-21): the work is done and nothing else starts until somebody has read it.
      // Whatever is queued stays queued, so letting it through is the same loop, entered again.
      if (task.gate === "human" && !stopped()) return "paused"
    }
    return "done"
  }
}
