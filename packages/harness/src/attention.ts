import type { RunStatus, RunVerdict } from "./types"

/**
 * What needs the reader, most urgent first (UX-02): one scale for sessions, runs and routines, so
 * a glance at any of them answers "what needs me" the same way.
 *
 * Live states hold while the engine or the harness says so: a permission or a gate waiting to be
 * let through, a question waiting for an answer, work going on. Outcomes — how finished work ended —
 * only count until the reader has seen them: a failure already looked at needs nobody.
 */
export const ATTENTION = ["approval", "answer", "failed", "unverified", "running", "unseen"] as const

export type Attention = (typeof ATTENTION)[number]

/** The most urgent of the levels given, or nothing when none applies. */
export function worstAttention(levels: Array<Attention | undefined | false>) {
  return levels
    .filter((level): level is Attention => !!level)
    .sort((a, b) => ATTENTION.indexOf(a) - ATTENTION.indexOf(b))[0]
}

/** What a collapsed group says for its rows: the most urgent level and how many rows are at it. */
export function tallyAttention(levels: Array<Attention | undefined>) {
  const level = worstAttention(levels)
  if (!level) return undefined
  return { level, count: levels.filter((entry) => entry === level).length }
}

/** The live state of a session as the engine reports it, plus what this window saw it end with. */
export type SessionSignals = {
  /** A permission is waiting for the reader. */
  approval: boolean
  /** A question is waiting for the reader. */
  answer: boolean
  running: boolean
  /** Its last turn failed (an error the engine reported, not a stop). */
  failed: boolean
  /** It finished while the reader was elsewhere, and they have not opened it since. */
  unseen: boolean
}

export function sessionAttention(signals: SessionSignals) {
  return worstAttention([
    signals.approval && "approval",
    signals.answer && "answer",
    signals.running && "running",
    signals.unseen && (signals.failed ? "failed" : "unseen"),
  ])
}

/** A run as far as attention goes: what the harness says of it and the sessions its work runs in. */
export type RunLike = {
  status: RunStatus
  sessionID?: string
  verdict?: Pick<RunVerdict, "value">
  tasks?: Array<{ sessionID?: string }>
}

/**
 * A run's level. A gate (or a budget pause) is an approval; a task's session waiting on a
 * permission or a question is the same as that session's own wait. Once finished, the verdict
 * (RP-06) decides what it ended as, until it is seen: an agent that asked the reader something and
 * stopped needs an answer; a failed run or a failed verdict is a failure; work nothing checked is
 * not verified; anything else simply finished.
 */
export function runAttention(run: RunLike, pending: { approval: string[]; answer: string[] }, seen: boolean) {
  const sessions = [run.sessionID, ...(run.tasks ?? []).map((task) => task.sessionID)].filter(
    (id): id is string => !!id,
  )
  const going = run.status === "running" || run.status === "awaiting"
  return worstAttention([
    (run.status === "awaiting" || sessions.some((id) => pending.approval.includes(id))) && "approval",
    sessions.some((id) => pending.answer.includes(id)) && "answer",
    going && "running",
    !going && !seen && runOutcome(run),
  ])
}

function runOutcome(run: RunLike): Attention {
  if (run.verdict?.value === "needs-user") return "answer"
  if (run.status === "failed" || run.verdict?.value === "failed") return "failed"
  if (run.verdict?.value === "unverified") return "unverified"
  return "unseen"
}
