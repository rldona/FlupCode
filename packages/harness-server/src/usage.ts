/**
 * What the runs cost (H-16).
 *
 * The home screen counts tokens and has never shown a price, an agent or a model — it is computed
 * in the browser from the engine's session list, which knows what a session spent in total and
 * nothing about why. The harness knows the why, because it wrote it down: which run, which task,
 * which agent, which model, and which attempt.
 *
 * Attempt is the one that matters most and the one nobody could see. A bounded retry is a **new
 * task** (that was the whole point of H-22's design), so work done twice is paid for twice — and
 * until now the second bill was mixed in with the first.
 *
 * This is deliberately only about runs. The harness does not see an ordinary chat turn, and adding
 * the engine's session totals on top would count every run task twice, since a task *is* a session.
 * Better one number with a clear owner than two that quietly overlap.
 */

export type UsageRow = {
  runID: string
  directory?: string
  taskID: string
  name: string
  kind: string
  agent?: string
  model?: { providerID: string; id: string }
  attempt: number
  status: string
  startedAt?: number
  finishedAt?: number
  tokens?: number
  cost?: number
}

export type Spend = { tasks: number; tokens: number; cost: number }

export type UsageReport = {
  totals: Spend & { runs: number; ms: number }
  /** Work done for the second time or later: paid twice, and invisible until it is split out. */
  retries: Spend
  byModel: Array<Spend & { key: string }>
  byAgent: Array<Spend & { key: string }>
  byProject: Array<Spend & { key: string; runs: number }>
  byDay: Array<{ day: string; tokens: number; cost: number }>
  /** The longest tasks, which is where the time went even when the price was small. */
  slowest: Array<{ taskID: string; runID: string; name: string; ms: number }>
}

const empty = (): Spend => ({ tasks: 0, tokens: 0, cost: 0 })

const add = (into: Spend, row: UsageRow) => {
  into.tasks++
  into.tokens += row.tokens ?? 0
  into.cost += row.cost ?? 0
}

const bucket = (map: Map<string, Spend>, key: string, row: UsageRow) => {
  const found = map.get(key) ?? empty()
  add(found, row)
  map.set(key, found)
}

/** Biggest bill first; a tie goes to the name, so the order never wobbles between reads. */
const ranked = (map: Map<string, Spend>) =>
  [...map.entries()]
    .map(([key, spend]) => ({ key, ...spend }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key))

/** The local day a moment falls on, as `YYYY-MM-DD`. Local, because the reader's week is local. */
export function dayOf(at: number) {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

const modelKey = (row: UsageRow) => (row.model ? `${row.model.providerID}/${row.model.id}` : "")

/**
 * Adds the rows up.
 *
 * A pure function over rows, so what it counts can be checked without a database and without a run
 * — which matters, because the thing that would be wrong here is arithmetic nobody looks at twice.
 */
export function summarise(rows: UsageRow[]): UsageReport {
  const totals = { ...empty(), runs: 0, ms: 0 }
  const retries = empty()
  const byModel = new Map<string, Spend>()
  const byAgent = new Map<string, Spend>()
  const byProject = new Map<string, Spend>()
  const projectRuns = new Map<string, Set<string>>()
  const byDay = new Map<string, { tokens: number; cost: number }>()
  const runs = new Set<string>()
  const durations: UsageReport["slowest"] = []

  for (const row of rows) {
    add(totals, row)
    runs.add(row.runID)
    // Only what actually ran: a queued task has no duration, and a stopped one's is not work done.
    if (row.startedAt && row.finishedAt && row.finishedAt >= row.startedAt) {
      const ms = row.finishedAt - row.startedAt
      totals.ms += ms
      durations.push({ taskID: row.taskID, runID: row.runID, name: row.name, ms })
    }
    if (row.attempt > 1) add(retries, row)

    const model = modelKey(row)
    // A verify task runs no model at all, so counting it under one would invent a bill.
    if (model) bucket(byModel, model, row)
    if (row.agent) bucket(byAgent, row.agent, row)
    if (row.directory) {
      bucket(byProject, row.directory, row)
      const seen = projectRuns.get(row.directory) ?? new Set<string>()
      seen.add(row.runID)
      projectRuns.set(row.directory, seen)
    }
    if (row.startedAt) {
      const day = dayOf(row.startedAt)
      const found = byDay.get(day) ?? { tokens: 0, cost: 0 }
      found.tokens += row.tokens ?? 0
      found.cost += row.cost ?? 0
      byDay.set(day, found)
    }
  }

  totals.runs = runs.size
  return {
    totals,
    retries,
    byModel: ranked(byModel),
    byAgent: ranked(byAgent),
    byProject: ranked(byProject).map((entry) => ({ ...entry, runs: projectRuns.get(entry.key)?.size ?? 0 })),
    byDay: [...byDay.entries()]
      .map(([day, spend]) => ({ day, ...spend }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    slowest: durations.sort((a, b) => b.ms - a.ms).slice(0, 10),
  }
}
