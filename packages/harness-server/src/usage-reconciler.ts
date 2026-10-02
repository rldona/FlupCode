import type { Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"

/**
 * The usage reconciler (UL-03, audit §8.4 "Captura", item 2).
 *
 * The live plugin can miss facts: it is inert without its token, the engine can restart mid-step,
 * the harness can be down. So the server reads what the engine itself kept and stores whatever the
 * ledger lacks. On 2.0.18 that is each session's transcript: `session.log` returns no events, since
 * the engine does not persist them, so every billable fact is read from the messages that carry it.
 * Rows are keyed as the plugin keys them, so a fact both paths saw is stored once.
 *
 * A pass lists the sessions the engine changed since the previous pass and reads each one that is
 * idle and changed since it was last read (its `time.updated`, kept in `usage_reconciled`). The first
 * pass after a start reads the whole list, which is the one-time backfill and the catch-up after the
 * harness was down; the ones after it run every `intervalMs`, which is how a session that just went
 * idle is reconciled. A busy session is left for the pass after it finishes.
 */
export function createUsageReconciler(input: {
  repository: Pick<SqliteRoutineRepository, "recordUsage" | "usageReconciled" | "markUsageReconciled">
  engine: Pick<Engine, "sessionsUpdatedSince" | "sessionUsage">
  intervalMs?: number
  log?: (line: string) => void
}) {
  const log = input.log ?? ((line: string) => console.log(line))
  // The engine's clock, never this process's: 0 until a pass completes, so the first reads everything.
  let floor = 0
  let pass: Promise<{ sessions: number; events: number; tools: number }> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let failing = false
  let stopped = false

  const reconcile = async () => {
    const listed = await input.engine.sessionsUpdatedSince(floor)
    if (stopped) return { sessions: 0, events: 0, tools: 0 }
    const changed = listed.filter(
      (session) => !session.busy && session.updated !== input.repository.usageReconciled(session.id),
    )
    // The backfill's progress: what it is about to read and what it found, once, in the server log.
    const backfill = floor === 0 && changed.length > 0
    if (backfill) log(`Usage ledger: reconciling ${changed.length} engine sessions`)
    let events = 0
    let tools = 0
    for (const session of changed) {
      const usage = await input.engine.sessionUsage(session.id)
      // Stopped while the engine answered: the database may be closed already, and the next start reads it.
      if (stopped) break
      const stored = usage ? input.repository.recordUsage(usage) : { events: 0, tools: 0 }
      events += stored.events
      tools += stored.tools
      input.repository.markUsageReconciled(session.id, session.updated)
    }
    if (stopped) return { sessions: 0, events, tools }
    if (backfill)
      log(`Usage ledger: reconciled ${changed.length} engine sessions (${events} new events, ${tools} new tools)`)
    // Up to the newest change seen, but never past a session still running: it is read once it ends.
    floor = Math.min(
      listed.reduce((newest, session) => Math.max(newest, session.updated), floor),
      ...listed.filter((session) => session.busy).map((session) => session.updated),
    )
    return { sessions: changed.length, events, tools }
  }

  /** One pass; a pass already running is joined rather than started twice. */
  const sweep = () => {
    pass ??= reconcile().finally(() => {
      pass = undefined
    })
    return pass
  }

  return {
    sweep,
    start: () => {
      const tick = () =>
        void sweep().then(
          () => {
            failing = false
          },
          (cause: unknown) => {
            // An engine that is down fails every pass: said once, until a pass works again.
            if (!failing)
              console.error(
                `Could not reconcile the usage ledger: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            failing = true
          },
        )
      tick()
      timer = setInterval(tick, input.intervalMs ?? 60_000)
    },
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
