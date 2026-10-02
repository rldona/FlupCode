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
 *
 * Since UL-05 the task rows `summarise` adds up take their tokens and cost from the usage ledger, so
 * `/harness/usage` is a view of it in its old shape, kept for the screen that reads it until UL-06
 * moves that screen to the summary below. New code reads the summary.
 */

import type { SqliteRoutineRepository } from "./repository"
import { repositoryRoot, type Billing, type CostBasis, type UsageTokens } from "./usage-ledger"

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
    byDay: [...byDay.entries()].map(([day, spend]) => ({ day, ...spend })).sort((a, b) => a.day.localeCompare(b.day)),
    slowest: durations.sort((a, b) => b.ms - a.ms).slice(0, 10),
  }
}

// ---- the usage summary (UL-05) -------------------------------------------------------------------

/**
 * Every way the ledger can be added up (audit §8.4, "Dimensiones que el ledger responde"). `session`
 * is a session with its subagents, folded onto the session the tree starts from; `tag` groups by the
 * value of one named tag, so each row falls in exactly one group.
 */
export const USAGE_DIMENSIONS = [
  "run",
  "task",
  "workflow",
  "routine",
  "agent",
  "model",
  "provider",
  "directory",
  "tag",
  "purpose",
  "day",
  "session",
] as const
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number]

export type UsageFields = Record<string, string | number | null>

/**
 * Ledger rows added up per group, cost basis and billing, as the repository answers: `priced` rows
 * carry a cost the engine (or FlupCode) put on them, the rest are unpriced and their cost is never
 * read, so they cannot turn into $0.
 */
export type UsageTotalRow = {
  fields: UsageFields
  basis: CostBasis
  billing: Billing
  priced: boolean
  events: number
  tokens: UsageTokens
  usd: number
}

/** Money with what it is: whose price (`basis`) and whether it was spent (`billing`). */
export type MoneyLine = { basis: Exclude<CostBasis, "unpriced">; billing: Billing; usd: number; events: number }

/**
 * What a set of ledger rows adds up to. `tokens` covers every row; `money` only the priced ones, one
 * line per basis and billing, so no figure leaves without its lens; `unpriced` is what had no price
 * at all, as counts and tokens, never as $0.
 */
export type UsageBucket = {
  events: number
  tokens: UsageTokens
  money: MoneyLine[]
  unpriced: { events: number; tokens: UsageTokens }
}

/** One group: `key` identifies it (null for the rows the dimension does not name); `fields` say what it is. */
export type UsageGroup = UsageBucket & { key: string | null; fields: UsageFields }

export type UsageSummary = {
  groupBy: UsageDimension | null
  total: UsageBucket
  /** Biggest bill first (by day, oldest first), cut to the limit; the cut ones are in `rest`. */
  groups: UsageGroup[]
  rest?: UsageBucket & { groups: number }
}

export const DEFAULT_GROUP_LIMIT = 100
export const MAX_GROUP_LIMIT = 1000

const noTokens = (): UsageTokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

const addTokens = (into: UsageTokens, tokens: UsageTokens) => {
  into.input += tokens.input
  into.output += tokens.output
  into.reasoning += tokens.reasoning
  into.cacheRead += tokens.cacheRead
  into.cacheWrite += tokens.cacheWrite
}

const emptyBucket = (): UsageBucket => ({
  events: 0,
  tokens: noTokens(),
  money: [],
  unpriced: { events: 0, tokens: noTokens() },
})

/** Adds one row of the repository's answer to a bucket. */
function addRow(into: UsageBucket, row: UsageTotalRow) {
  into.events += row.events
  addTokens(into.tokens, row.tokens)
  if (!row.priced || row.basis === "unpriced") {
    into.unpriced.events += row.events
    addTokens(into.unpriced.tokens, row.tokens)
    return
  }
  addLine(into, { basis: row.basis, billing: row.billing, usd: row.usd, events: row.events })
}

/** Adds a whole bucket to another: the groups cut by the limit, added into `rest`. */
function addBucket(into: UsageBucket, bucket: UsageBucket) {
  into.events += bucket.events
  addTokens(into.tokens, bucket.tokens)
  into.unpriced.events += bucket.unpriced.events
  addTokens(into.unpriced.tokens, bucket.unpriced.tokens)
  for (const line of bucket.money) addLine(into, line)
}

/** Money lines merge only with the same basis and billing: an estimate is never added to spend. */
function addLine(into: UsageBucket, line: MoneyLine) {
  const found = into.money.find((entry) => entry.basis === line.basis && entry.billing === line.billing)
  if (!found) {
    into.money.push({ ...line })
    return
  }
  found.usd += line.usd
  found.events += line.events
}

export function bucketOf(rows: UsageTotalRow[]) {
  const bucket = emptyBucket()
  for (const row of rows) addRow(bucket, row)
  return sortLines(bucket)
}

/** What a bucket's priced lines add up to, used only to rank groups. */
const usdOf = (bucket: UsageBucket) => bucket.money.reduce((sum, line) => sum + line.usd, 0)
const tokensOf = (tokens: UsageTokens) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite

function sortLines<T extends UsageBucket>(bucket: T) {
  bucket.money.sort((a, b) => a.basis.localeCompare(b.basis) || a.billing.localeCompare(b.billing))
  return bucket
}

/**
 * The ledger's rows folded into the groups of one dimension.
 *
 * `parents` maps a session to the one it is a subagent of, for `session`: each session's rows go to
 * the session its tree starts from, so a conversation's figure includes what its subagents spent.
 * The engine's own `SessionInfo.cost` of a parent leaves its children out (verified in UL-04), so
 * summing the tree counts nothing twice.
 */
export function summariseUsage(
  rows: UsageTotalRow[],
  input: { groupBy?: UsageDimension; limit?: number; parents?: Map<string, string> } = {},
): UsageSummary {
  const total = bucketOf(rows)
  if (!input.groupBy) return { groupBy: null, total, groups: [] }
  const dimension = input.groupBy
  const groups = new Map<string | null, UsageGroup & { sessions?: Set<string> }>()
  for (const row of rows) {
    const fields = dimension === "session" ? rootFields(row.fields, input.parents) : row.fields
    const key = keyOf(dimension, fields)
    const group = groups.get(key) ?? { ...emptyBucket(), key, fields }
    addRow(group, row)
    if (dimension === "session" && typeof row.fields.sessionID === "string")
      (group.sessions ??= new Set()).add(row.fields.sessionID)
    groups.set(key, group)
  }
  const ranked = [...groups.values()]
    .map(({ sessions, ...group }) =>
      sortLines(sessions ? { ...group, fields: { ...group.fields, sessions: sessions.size } } : group),
    )
    .sort(dimension === "day" ? byKey : byBill)
  const limit = clampGroupLimit(input.limit)
  const cut = ranked.slice(limit)
  return {
    groupBy: dimension,
    total,
    groups: ranked.slice(0, limit),
    ...(cut.length > 0
      ? {
          rest: {
            ...sortLines(cut.reduce((sum, group) => (addBucket(sum, group), sum), emptyBucket())),
            groups: cut.length,
          },
        }
      : {}),
  }
}

function clampGroupLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_GROUP_LIMIT
  return Math.min(MAX_GROUP_LIMIT, Math.floor(limit))
}

/**
 * A group's identity: the dimension's own id, or its ids joined with `/` where it takes several (a
 * model is its provider, its id and its variant). `null` when the row does not name it, e.g. a chat's
 * rows grouped by run: they are a group of their own, so every row is still counted once.
 */
function keyOf(dimension: UsageDimension, fields: UsageFields) {
  const primary = {
    run: "runID",
    task: "taskID",
    workflow: "workflowName",
    routine: "routineID",
    agent: "agent",
    model: "modelID",
    provider: "providerID",
    directory: "directory",
    tag: "tag",
    purpose: "purpose",
    day: "day",
    session: "sessionID",
  }[dimension]
  if (fields[primary] === null || fields[primary] === undefined) return null
  if (dimension === "workflow")
    return [fields.workflowName, fields.workflowHash].filter((part) => part !== null).join("@")
  if (dimension === "model")
    return [fields.providerID, fields.modelID, fields.variant].filter((part) => part !== null).join("/")
  return String(fields[primary])
}

function rootFields(fields: UsageFields, parents = new Map<string, string>()): UsageFields {
  let root = typeof fields.sessionID === "string" ? fields.sessionID : null
  // Bounded like the attribution chain: a loop in bad data is cut rather than followed forever.
  for (let depth = 0; root && parents.has(root) && depth < 32; depth++) root = parents.get(root)!
  return { sessionID: root }
}

const byBill = (a: UsageGroup, b: UsageGroup) =>
  usdOf(b) - usdOf(a) ||
  tokensOf(b.tokens) - tokensOf(a.tokens) ||
  (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
  (a.key ?? "").localeCompare(b.key ?? "")

const byKey = (a: UsageGroup, b: UsageGroup) =>
  (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) || (a.key ?? "").localeCompare(b.key ?? "")

/** A session with its subagents (`GET /harness/usage/sessions/:id`). */
export type UsageSessionReport = {
  sessionID: string
  /** The session and every subagent under it: the sum over the tree, nothing subtracted. */
  total: UsageBucket
  /** The session's own rows, without its subagents. */
  own: UsageBucket
  /** Every session of the tree that has rows, the asked one first, then by depth. */
  sessions: Array<UsageBucket & { sessionID: string; parentSessionID: string | null; depth: number }>
  byAgent: UsageGroup[]
}

export function sessionReport(
  sessionID: string,
  tree: Array<{ sessionID: string; parentSessionID: string | null; depth: number }>,
  rows: UsageTotalRow[],
  agents: UsageTotalRow[],
): UsageSessionReport {
  const bySession = Map.groupBy(rows, (row) => String(row.fields.sessionID))
  const sessions = tree
    .filter((member) => bySession.has(member.sessionID))
    .map((member) => ({ ...bucketOf(bySession.get(member.sessionID)!), ...member }))
  return {
    sessionID,
    total: bucketOf(rows),
    own: bucketOf(bySession.get(sessionID) ?? []),
    sessions,
    byAgent: summariseUsage(agents, { groupBy: "agent", limit: MAX_GROUP_LIMIT }).groups,
  }
}

/** A run's cost (`GET /harness/usage/runs/:id`): its tasks, and its handoffs and other purposes apart. */
export type UsageRunReport = {
  runID: string
  total: UsageBucket
  byTask: UsageGroup[]
  byPurpose: UsageGroup[]
  byAgent: UsageGroup[]
  byModel: UsageGroup[]
}

export function runReport(
  runID: string,
  rows: Record<"task" | "purpose" | "agent" | "model", UsageTotalRow[]>,
): UsageRunReport {
  const all = { limit: MAX_GROUP_LIMIT }
  const byTask = summariseUsage(rows.task, { ...all, groupBy: "task" })
  return {
    runID,
    total: byTask.total,
    byTask: byTask.groups,
    byPurpose: summariseUsage(rows.purpose, { ...all, groupBy: "purpose" }).groups,
    byAgent: summariseUsage(rows.agent, { ...all, groupBy: "agent" }).groups,
    byModel: summariseUsage(rows.model, { ...all, groupBy: "model" }).groups,
  }
}

type UsageReader = Pick<
  SqliteRoutineRepository,
  "usageTotals" | "usageSessionParents" | "usageSessionTree" | "knowsRunUsage"
>

/**
 * `GET /harness/usage/summary`, `/harness/usage/sessions/:id` and `/harness/usage/runs/:id`: the
 * ledger read back (UL-05), behind the UI's bearer like every other read. `undefined` for any other
 * path, so the caller goes on to its other routes.
 */
export function handleUsageRead(request: Request, path: string[], repository: UsageReader) {
  if (request.method !== "GET" || path[1] !== "usage") return undefined
  if (path[2] === "summary" && path.length === 3) return summaryRead(new URL(request.url).searchParams, repository)
  if (path[2] === "sessions" && path[3] && path.length === 4) {
    const sessionID = path[3]
    const tree = repository.usageSessionTree(sessionID)
    const rows = repository.usageTotals({ groupBy: "session", sessionIDs: tree.map((member) => member.sessionID) })
    const agents = repository.usageTotals({ groupBy: "agent", sessionIDs: tree.map((member) => member.sessionID) })
    return Response.json({ data: sessionReport(sessionID, tree, rows, agents) })
  }
  if (path[2] === "runs" && path[3] && path.length === 4) {
    const runID = path[3]
    if (!repository.knowsRunUsage(runID))
      return Response.json({ error: "Run not found", code: "not_found" }, { status: 404 })
    return Response.json({
      data: runReport(runID, {
        task: repository.usageTotals({ groupBy: "task", runID }),
        purpose: repository.usageTotals({ groupBy: "purpose", runID }),
        agent: repository.usageTotals({ groupBy: "agent", runID }),
        model: repository.usageTotals({ groupBy: "model", runID }),
      }),
    })
  }
  return undefined
}

function summaryRead(params: URLSearchParams, repository: UsageReader) {
  const groupBy = params.get("groupBy") ?? undefined
  if (groupBy !== undefined && !USAGE_DIMENSIONS.includes(groupBy as UsageDimension))
    return invalid(`groupBy must be one of ${USAGE_DIMENSIONS.join(", ")}`)
  const tag = params.get("tag") ?? undefined
  if (groupBy === "tag" && !tag) return invalid("groupBy=tag needs the tag to group by, as tag=<name>")
  const from = moment(params.get("from"))
  const to = moment(params.get("to"))
  const limit = moment(params.get("limit"))
  if (from === null || to === null || limit === null) return invalid("from, to and limit must be non-negative numbers")
  const directory = params.get("directory") || undefined
  const filter = {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    // Rows keep the repository a worktree belongs to, so the folder asked for is resolved the same way.
    ...(directory ? { directory: repositoryRoot(directory) } : {}),
  }
  const dimension = groupBy as UsageDimension | undefined
  const rows = repository.usageTotals({
    ...filter,
    ...(dimension ? { groupBy: dimension } : {}),
    ...(tag ? { tag } : {}),
  })
  return Response.json({
    data: summariseUsage(rows, {
      ...(dimension ? { groupBy: dimension } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(dimension === "session" ? { parents: repository.usageSessionParents() } : {}),
    }),
  })
}

/** A query number: `undefined` when absent, `null` when it is not a non-negative number. */
function moment(value: string | null) {
  if (value === null || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function invalid(message: string) {
  return Response.json({ error: message, code: "invalid_request" }, { status: 400 })
}
