import type { Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, Task } from "./types"

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

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
