import type { Run, Task, TouchedFiles } from "./types"

/**
 * Two runs, side by side (H-33).
 *
 * The audit asks for a comparison by tokens, cost, duration, files and verdict, and calls it the
 * base for best-of-n without building best-of-n. All of it is already on the server — the run, its
 * tasks and what each one changed — so this is arithmetic over what a reader can already fetch, and
 * it is kept out of the component so it can be tested without a browser. Context packs joined it
 * (H-40): they travel on the run row, so two executions can also be told apart by what they were
 * handed.
 */

export type RunSnapshot = {
  id: string
  status: string
  durationMs?: number
  tasks: { total: number; success: number; failed: number; skipped: number; running: number; queued: number }
  tokens: number
  cost: number
  /** Every path any task of the run changed, without repeats. */
  files: string[]
  /** What the run's checks said, when it had one. */
  verdict?: { status: string; detail?: string }
  /**
   * The context packs the run was given, by name (H-31), so two executions can be told apart by
   * what they were handed (H-40). Instructions are deliberately not here: they are read from disk
   * when somebody looks, so they are not a property of the run, and two runs in one folder share
   * them unless the files were edited in between — the Context Inspector shows them.
   */
  packs?: string[]
}

const terminal = (status: string) => status === "success" || status === "failed" || status === "skipped"

export function runSnapshot(run: Run, tasks: Task[], files: TouchedFiles[]): RunSnapshot {
  const count = (status: string) => tasks.filter((task) => task.status === status).length
  const checks = tasks.filter((task) => task.kind === "verify")
  const last = checks.at(-1)
  const detail = last?.error ?? last?.output?.split("\n").find((line) => line.trim())
  return {
    id: run.id,
    status: run.status,
    ...(run.finishedAt !== undefined || run.status === "running"
      ? { durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt) }
      : {}),
    tasks: {
      total: tasks.length,
      success: count("success"),
      failed: count("failed"),
      skipped: count("skipped"),
      running: count("running"),
      queued: count("queued"),
    },
    tokens: tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0),
    cost: tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    files: [...new Set(files.flatMap((entry) => entry.files.map((file) => file.path)))].sort(),
    ...(last ? { verdict: { status: last.status, ...(detail ? { detail } : {}) } } : {}),
    ...(run.packs && run.packs.length > 0 ? { packs: run.packs } : {}),
  }
}

export function formatDuration(ms: number | undefined) {
  if (ms === undefined) return "—"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export type ComparisonRow = {
  label: string
  a: string
  b: string
  /** The difference, b against a, for the rows where one makes sense. */
  delta?: string
}

const signed = (value: number, format: (value: number) => string) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${format(Math.abs(value))}`

export function compareRuns(a: RunSnapshot, b: RunSnapshot): ComparisonRow[] {
  const taskLine = (snapshot: RunSnapshot) => {
    const parts = [`${snapshot.tasks.success}/${snapshot.tasks.total}`]
    if (snapshot.tasks.failed > 0) parts.push(`${snapshot.tasks.failed} failed`)
    if (snapshot.tasks.skipped > 0) parts.push(`${snapshot.tasks.skipped} skipped`)
    if (snapshot.tasks.running > 0) parts.push(`${snapshot.tasks.running} running`)
    return parts.join(", ")
  }
  const verdictLine = (snapshot: RunSnapshot) =>
    snapshot.verdict ? `${snapshot.verdict.status}${snapshot.verdict.detail ? ` — ${snapshot.verdict.detail}` : ""}` : "—"
  // No difference column: a list of names is not something to subtract, and "none" is a value.
  const packsLine = (snapshot: RunSnapshot) => (snapshot.packs?.length ? snapshot.packs.join(", ") : "—")
  const durations = [a.durationMs, b.durationMs]
  const comparableDuration = durations.every((value) => value !== undefined)
  return [
    { label: "Status", a: a.status, b: b.status },
    {
      label: "Duration",
      a: formatDuration(a.durationMs),
      b: formatDuration(b.durationMs),
      ...(comparableDuration ? { delta: signed(b.durationMs! - a.durationMs!, formatDuration) } : {}),
    },
    { label: "Tasks", a: taskLine(a), b: taskLine(b) },
    {
      label: "Tokens",
      a: String(a.tokens),
      b: String(b.tokens),
      delta: signed(b.tokens - a.tokens, String),
    },
    {
      label: "Cost",
      a: `$${a.cost.toFixed(4)}`,
      b: `$${b.cost.toFixed(4)}`,
      delta: signed(b.cost - a.cost, (value) => `$${value.toFixed(4)}`),
    },
    {
      label: "Files changed",
      a: String(a.files.length),
      b: String(b.files.length),
      delta: signed(b.files.length - a.files.length, String),
    },
    { label: "Verdict", a: verdictLine(a), b: verdictLine(b) },
    { label: "Context packs", a: packsLine(a), b: packsLine(b) },
  ]
}
