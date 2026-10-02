import { t } from "./i18n"
import type { Run, Task, VerdictValue } from "./types"

/**
 * Where a run or a task stands, as one word (UX-04). While it goes, its status; once its turns have
 * finished, its verdict (RP-06), because that is how it ended: a task whose agent gave up finished
 * its turn, and saying "success" next to "failed" is two answers to one question (P4, P5). A finished
 * task nothing judged (an external command, a web action) says it succeeded, which is all that is known.
 */
export type RunState =
  | VerdictValue
  | "running"
  | "approval"
  | "budget"
  | "queued"
  | "skipped"
  | "stopped"
  | "succeeded"

/** The app's own words: the verdict's (RP-06) and the attention scale's (UX-02) where they exist. */
const LABELS: Record<RunState, string> = {
  verified: "Verified",
  unverified: "Not verified",
  "needs-user": "Needs your input",
  failed: "Failed",
  running: "Running",
  approval: "Needs approval",
  budget: "Paused at its budget",
  queued: "Queued",
  skipped: "Skipped",
  stopped: "Stopped",
  succeeded: "Succeeded",
}

export const stateLabel = (state: RunState) => t(LABELS[state])

export function taskState(task: Task): RunState {
  if (task.status !== "success") return task.status
  return task.verdict?.value ?? "succeeded"
}

/** How a run stands, said once on its card: the gate or the budget it waits at, or how it ended. */
export function runState(run: Pick<Run, "status" | "paused" | "verdict">): RunState {
  if (run.status === "awaiting") return run.paused === "budget" ? "budget" : "approval"
  if (run.status !== "success") return run.status
  return run.verdict?.value ?? "succeeded"
}

/**
 * What the run's one word rests on, for its tooltip: the budget it waits at (UL-08), the verdict's
 * reason, or the run's error.
 */
export function runReason(run: Run) {
  const state = runState(run)
  if (state === "budget") return run.overBudget
  return state === run.verdict?.value ? run.verdict.reason : run.error
}

/** Held mid-turn for a person (RP-05): answered in the engine, never approved like a gate. */
export const heldForRequest = (run: Run) => run.status === "awaiting" && run.paused === "request"

/**
 * Where a run met a task that needs a person (RP-05): held for it, or failed for it — a failed task
 * judged as needing the user is the one way a run's task fails for that.
 */
export const metPerson = (run: Run) =>
  heldForRequest(run) ||
  (run.tasks ?? []).some((task) => task.status === "failed" && task.verdict?.value === "needs-user")
