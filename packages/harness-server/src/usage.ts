/**
 * What the work cost, read back from the usage ledger (UL-05).
 *
 * Every cost figure of the app comes from here: the Cost screen's summary by any dimension, a session
 * with its subagents (and, for the composer, what it spent since the turn's prompt) and a run with its
 * tasks and handoffs. Money stays per cost basis and billing, and rows with no price are counted as
 * unpriced, never as $0. The old per-task view (`/harness/usage`, H-16) went with the screen that
 * read it (UL-06).
 */

import type { SqliteRoutineRepository } from "./repository"
import { repositoryRoot, type Billing, type CostBasis, type UsageTokens } from "./usage-ledger"

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
  /**
   * What the tree spent from `from` on, when it was asked (`?from=`): the composer asks from the
   * prompt of the turn in progress, so the turn's cost is the ledger's like every other figure.
   */
  since?: UsageBucket
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
    const from = moment(new URL(request.url).searchParams.get("from"))
    if (from === null) return invalid("from must be a non-negative number")
    const tree = repository.usageSessionTree(sessionID)
    const sessionIDs = tree.map((member) => member.sessionID)
    const rows = repository.usageTotals({ groupBy: "session", sessionIDs })
    const agents = repository.usageTotals({ groupBy: "agent", sessionIDs })
    const report = sessionReport(sessionID, tree, rows, agents)
    if (from === undefined) return Response.json({ data: report })
    return Response.json({ data: { ...report, since: bucketOf(repository.usageTotals({ sessionIDs, from })) } })
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
