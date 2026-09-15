import type { Routine } from "./types"

/**
 * Whether a routine is due at `now`. It must be enabled and have a positive interval: routines are
 * stored in the browser, so a value written by an older build (0, negative or not a number) would
 * otherwise make `now - lastRunAt` always exceed the interval and fire on every scheduler tick.
 */
export function routineDue(routine: Routine, now: number) {
  if (!routine.enabled) return false
  if (!Number.isFinite(routine.intervalMinutes) || routine.intervalMinutes <= 0) return false
  return !routine.lastRunAt || now - routine.lastRunAt >= routine.intervalMinutes * 60_000
}
