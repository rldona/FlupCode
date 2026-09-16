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
  return [`Previous step (${handoff.length > 4000 ? "truncated" : "complete"}):`, handoff.slice(0, 4000), "", task.prompt].join("\n")
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

  async execute(run: Run, options: { directory?: string; stopped?: () => boolean } = {}) {
    const stopped = options.stopped ?? (() => false)
    const tasks = this.repository.listTasks(run.id).filter((task) => task.status === "queued")
    // The run's own session is the thread a person reads; each task is a child of it, which is the
    // lineage the engine already keeps. A run of one task needs no thread of its own, and creating
    // one would leave an empty session in everybody's list.
    // Re-read: the run gained its session after it was started, when the caller decided the work
    // needed a thread of its own.
    const parentID = tasks.length > 1 ? (this.repository.getRun(run.id)?.sessionID ?? run.sessionID) : undefined
    let handoff: string | undefined

    for (const task of tasks) {
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
        // The evidence is the handoff: whatever runs next is told exactly what failed.
        handoff = evidence
        if (!report.ok && !stopped()) throw new VerifyFailed(failureSummary(report.steps))
        continue
      }
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
  }
}
