/**
 * What each session cost (AH-B02).
 *
 * `session_metrics` keeps one row per turn; the cost screen wants one line per session and a total,
 * and asking for every session one by one would be a request per line. This adds the turns up on the
 * server, in the style of `usage.ts`: a pure function over rows, so the arithmetic — percentiles, the
 * cached share, the tool ranking — is checked without a database.
 */

import type { MetricTokens, SessionMetricTurn, ToolUse } from "./session-metrics"

/** Latency percentiles over a set of turns; absent when no turn measured it. */
export type Percentiles = { p50?: number; p95?: number }

export type ToolTotal = ToolUse & { tool: string }

export type SessionSummary = {
  sessionID: string
  projectID?: string
  providerID?: string
  modelID?: string
  agent?: string
  turns: number
  requests: number
  tokens: MetricTokens & { total: number }
  cost: number
  /** cacheRead / (input + cacheRead + cacheWrite): the share of the prompt the provider did not re-read. */
  cached: number
  turnMs: Percentiles
  firstTokenMs: Percentiles
  toolCalls: number
  toolErrors: number
  toolOutputBytes: number
  /** The session's biggest tools by output bytes: what filled its context. */
  topTools: ToolTotal[]
  compactions: number
  startedAt: number
  endedAt: number
}

export type SessionMetricsReport = {
  totals: {
    sessions: number
    turns: number
    tokens: MetricTokens & { total: number }
    cost: number
    cached: number
    turnMs: Percentiles
    firstTokenMs: Percentiles
  }
  /** The most recently active sessions first, cut to the limit; the totals cover them all. */
  sessions: SessionSummary[]
  topTools: ToolTotal[]
}

export type SessionSummaryFilter = { since?: number; projectID?: string; limit?: number }

export const DEFAULT_SESSION_LIMIT = 50
export const MAX_SESSION_LIMIT = 200
const SESSION_TOOLS = 5
const REPORT_TOOLS = 10

/**
 * Adds the turns up, per session and overall.
 *
 * A turn counts when it ended inside the window and belongs to the project asked for, so a session
 * that spans the window's edge reports only what it spent inside it.
 */
export function summariseSessions(turns: SessionMetricTurn[], filter: SessionSummaryFilter = {}): SessionMetricsReport {
  const kept = turns.filter(
    (turn) =>
      (filter.since === undefined || turn.endedAt >= filter.since) &&
      (filter.projectID === undefined || turn.projectID === filter.projectID),
  )
  const bySession = Map.groupBy(kept, (turn) => turn.sessionID)
  const sessions = [...bySession.values()]
    .map(summariseSession)
    .sort((a, b) => b.endedAt - a.endedAt || a.sessionID.localeCompare(b.sessionID))
  const tokens = sumTokens(kept)
  return {
    totals: {
      sessions: sessions.length,
      turns: kept.length,
      tokens,
      cost: kept.reduce((sum, turn) => sum + turn.cost, 0),
      cached: cachedShare(tokens),
      turnMs: percentiles(kept.map(turnDuration)),
      firstTokenMs: percentiles(firstTokens(kept)),
    },
    sessions: sessions.slice(0, clampLimit(filter.limit)),
    topTools: rankTools(kept, REPORT_TOOLS),
  }
}

/**
 * The nearest-rank percentile: the smallest value at least `p` per cent of the set is not above.
 * Nearest-rank rather than interpolated, so the answer is always a turn that really happened.
 */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

export function cachedShare(tokens: MetricTokens) {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return prompt > 0 ? tokens.cacheRead / prompt : 0
}

export function clampLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_SESSION_LIMIT
  return Math.min(MAX_SESSION_LIMIT, Math.floor(limit))
}

function summariseSession(turns: SessionMetricTurn[]): SessionSummary {
  const ordered = turns.toSorted((a, b) => a.turn - b.turn)
  const first = ordered[0]!
  // The latest turn names the model, like the fold does for a turn that switched models.
  const last = ordered.at(-1)!
  const tokens = sumTokens(ordered)
  const projectID = ordered.findLast((turn) => turn.projectID)?.projectID
  return {
    sessionID: first.sessionID,
    ...(projectID ? { projectID } : {}),
    ...(last.providerID ? { providerID: last.providerID } : {}),
    ...(last.modelID ? { modelID: last.modelID } : {}),
    ...(last.agent ? { agent: last.agent } : {}),
    turns: ordered.length,
    requests: ordered.reduce((sum, turn) => sum + turn.requests, 0),
    tokens,
    cost: ordered.reduce((sum, turn) => sum + turn.cost, 0),
    cached: cachedShare(tokens),
    turnMs: percentiles(ordered.map(turnDuration)),
    firstTokenMs: percentiles(firstTokens(ordered)),
    toolCalls: ordered.reduce((sum, turn) => sum + turn.toolCalls, 0),
    toolErrors: ordered.reduce((sum, turn) => sum + turn.toolErrors, 0),
    toolOutputBytes: ordered.reduce((sum, turn) => sum + turn.toolOutputBytes, 0),
    topTools: rankTools(ordered, SESSION_TOOLS),
    compactions: ordered.reduce((sum, turn) => sum + turn.compactions, 0),
    startedAt: ordered.reduce((least, turn) => Math.min(least, turn.startedAt), first.startedAt),
    endedAt: ordered.reduce((most, turn) => Math.max(most, turn.endedAt), first.endedAt),
  }
}

function sumTokens(turns: SessionMetricTurn[]): MetricTokens & { total: number } {
  const tokens = turns.reduce(
    (sum, turn) => ({
      input: sum.input + turn.tokens.input,
      output: sum.output + turn.tokens.output,
      reasoning: sum.reasoning + turn.tokens.reasoning,
      cacheRead: sum.cacheRead + turn.tokens.cacheRead,
      cacheWrite: sum.cacheWrite + turn.tokens.cacheWrite,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )
  return { ...tokens, total: tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite }
}

function percentiles(values: number[]): Percentiles {
  const p50 = percentile(values, 50)
  const p95 = percentile(values, 95)
  return { ...(p50 !== undefined ? { p50 } : {}), ...(p95 !== undefined ? { p95 } : {}) }
}

const turnDuration = (turn: SessionMetricTurn) => Math.max(0, turn.endedAt - turn.startedAt)

const firstTokens = (turns: SessionMetricTurn[]) =>
  turns.flatMap((turn) => (turn.firstTokenMs === undefined ? [] : [turn.firstTokenMs]))

/** Biggest output first; a tie goes to the name, so the order never wobbles between reads. */
function rankTools(turns: SessionMetricTurn[], limit: number): ToolTotal[] {
  const totals = turns
    .flatMap((turn) => Object.entries(turn.tools))
    .reduce((map, [tool, use]) => {
      const known = map.get(tool)
      map.set(tool, {
        calls: (known?.calls ?? 0) + use.calls,
        errors: (known?.errors ?? 0) + use.errors,
        bytes: (known?.bytes ?? 0) + use.bytes,
      })
      return map
    }, new Map<string, ToolUse>())
  return [...totals.entries()]
    .map(([tool, use]) => ({ tool, ...use }))
    .sort((a, b) => b.bytes - a.bytes || b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, limit)
}

/** What the repository needs to answer the summary read. */
export type SessionSummaryStore = {
  listSessionMetricTurns(filter: { since?: number; projectID?: string }): SessionMetricTurn[]
}

/** The browser's read: every session's summary in the window, in one request. */
export function handleSessionSummaryRead(request: Request, store: SessionSummaryStore): Response {
  const params = new URL(request.url).searchParams
  const since = optionalNumber(params.get("since"))
  const limit = optionalNumber(params.get("limit"))
  if (since === null || limit === null)
    return json({ error: "since and limit must be non-negative numbers", code: "bad_request" }, 400)
  const directory = params.get("directory") || undefined
  if (directory !== undefined && directory.length > 4096)
    return json({ error: "The directory is too long", code: "bad_request" }, 400)
  const filter = { ...(since !== undefined ? { since } : {}), ...(directory ? { projectID: directory } : {}) }
  return json({ data: summariseSessions(store.listSessionMetricTurns(filter), { ...filter, limit }) })
}

/** Absent is undefined; present and not a non-negative number is null, which the route refuses. */
function optionalNumber(value: string | null) {
  if (value === null || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })
