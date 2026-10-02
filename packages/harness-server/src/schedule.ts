import { Cron } from "croner"
import type { Routine, RoutineSchedule, Run } from "./types"

/**
 * When a routine fires (RP-07): its beats, the retry a failed run earned, and what it does about a
 * beat it missed. The one copy of this logic: the app shows the `nextRunAt` the server derives here.
 *
 * Wall-clock schedules (daily, weekdays, weekly, cron) are cron patterns read in the routine's time
 * zone by one parser, croner, which does its zone arithmetic with `Intl`. Across a daylight-saving
 * change a time the clocks skip runs that day as late as the change pushed it (02:30 becomes 03:30),
 * and a time the clocks repeat runs once, the first time it comes round. Hourly and interval
 * routines count elapsed time, so a zone changes nothing for them.
 */

/** Failed runs in a row that raise the routine's notice, once per streak. */
export const FAILED_IN_A_ROW_NOTICE = 3

/**
 * How late a beat may be found and still run under `missed: skip`. The tick runs every 30 seconds
 * and a busy one can take longer; anything later than this is a beat the server slept through.
 */
export const MISSED_GRACE_MS = 5 * 60 * 1000

const MINUTE = 60 * 1000

/** The next time this routine fires and, when that is a retry, which run it retries. */
export function nextFiring(routine: Routine, now: number): { at: number; retry?: { of: string; attempt: number } } | undefined {
  if (!routine.enabled || routine.schedule.type === "manual") return undefined
  const beat = nextBeat(routine, now)
  const retry = pendingRetry(routine)
  if (retry && (beat === undefined || retry.at < beat)) return retry
  return beat === undefined ? undefined : { at: beat }
}

export const nextRunAt = (routine: Routine, now: number) => nextFiring(routine, now)?.at

export const isDue = (routine: Routine, now: number) => {
  const next = nextRunAt(routine, now)
  return next !== undefined && next <= now
}

/**
 * How many of a routine's newest runs failed one after the other (RP-07): a run that failed, or
 * whose verdict (RP-06) is `failed` or `needs-user`. A run nothing checked (`unverified`) is not a
 * failure — it is how every routine without a check ends — so it ends the count like a verified
 * one. Runs still going, or stopped by somebody, say nothing about the routine and are passed over.
 */
export function failedInARow(runs: Run[]) {
  const settled = runs.filter((run) => run.status === "success" || run.status === "failed")
  const end = settled.findIndex((run) => !runFailed(run))
  return end === -1 ? settled.length : end
}

/** Why a schedule could never fire as written, or nothing when it can. Checked when it is saved. */
export function scheduleProblem(schedule: RoutineSchedule) {
  if (schedule.timezone && !knownZone(schedule.timezone)) return `Unknown time zone: ${schedule.timezone}`
  if ("time" in schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return "Write the time as HH:MM"
  const pattern = cronPattern(schedule)
  if (!pattern) return undefined
  try {
    if (!new Cron(pattern, { timezone: schedule.timezone }).nextRun()) return "This schedule never runs"
    return undefined
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

function nextBeat(routine: Routine, now: number) {
  const anchor = routine.lastRunAt ?? routine.createdAt
  // Catch-up fires once for every beat missed since the last run; skip only looks back as far as a
  // late tick could, so a beat the server slept through is left behind.
  const from = routine.missed === "skip" ? Math.max(anchor, now - MISSED_GRACE_MS) : anchor
  const schedule = routine.schedule
  if (schedule.type === "hourly" || schedule.type === "interval") {
    const step = (schedule.type === "hourly" ? 60 : schedule.intervalMinutes) * MINUTE
    return anchor + Math.max(1, Math.ceil((from - anchor) / step)) * step
  }
  const pattern = cronPattern(schedule)
  if (!pattern) return undefined
  try {
    return new Cron(pattern, { timezone: schedule.timezone }).nextRun(new Date(from))?.getTime()
  } catch {
    // Refused on save; a row written before that check is a routine that never fires, not a crash.
    return undefined
  }
}

/**
 * The retry the newest run earned, if any: a run that failed, or whose verdict failed, is tried again
 * `count` times, waiting `backoffMinutes` and doubling the wait each time. A run whose agent asked
 * the reader something is not retried: asking again answers nothing. Nor is one somebody stopped.
 */
function pendingRetry(routine: Routine) {
  const retry = routine.retry
  // Newest first. A run somebody stopped, or one still going, earns nothing.
  const last = routine.runs[0]
  if (!retry || retry.count < 1 || !last || last.status === "running" || last.status === "awaiting") return undefined
  if (last.status !== "failed" && last.verdict?.value !== "failed") return undefined
  const attempt = last.attempt ?? 1
  if (attempt > retry.count) return undefined
  const wait = retry.backoffMinutes * MINUTE * 2 ** (attempt - 1)
  return { at: (last.finishedAt ?? last.startedAt) + wait, retry: { of: last.id, attempt: attempt + 1 } }
}

function runFailed(run: Run) {
  return run.status === "failed" || run.verdict?.value === "failed" || run.verdict?.value === "needs-user"
}

/** A wall-clock schedule as a cron pattern (minute hour day month weekday). */
function cronPattern(schedule: RoutineSchedule) {
  if (schedule.type === "cron") return schedule.expression
  if (schedule.type !== "daily" && schedule.type !== "weekdays" && schedule.type !== "weekly") return undefined
  const [hours, minutes] = schedule.time.split(":").map(Number)
  const days = schedule.type === "daily" ? "*" : schedule.type === "weekdays" ? "1-5" : String(schedule.day)
  return `${minutes ?? 0} ${hours ?? 9} * * ${days}`
}

function knownZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}
