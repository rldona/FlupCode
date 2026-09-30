/**
 * The per-turn cost baseline (AH-B01).
 *
 * The installed `flupcode-session-metrics.js` plugin posts one observation per engine event — a
 * provider step's usage, a finished tool, a compaction — and this module folds them into one row per
 * turn: the user message that opened it. It covers every session, interactive or run, because the
 * engine emits the same events for both; nothing here knows which one it was.
 *
 * The wire carries numbers, ids and names only. The route validates the shape and caps every string
 * so a caller cannot hand the table a payload; the fold is pure so the arithmetic is tested without a
 * database.
 */

import type { Arm, HoldoutCapability } from "./holdout"

export type MetricTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export type MetricObservation =
  | {
      kind: "step"
      id: string
      turnID: string
      providerID?: string
      modelID?: string
      agent?: string
      tokens: MetricTokens
      cost: number
      ms: number
      firstTokenMs?: number
    }
  | { kind: "tool"; id: string; turnID: string; tool: string; error: boolean; bytes: number; skill?: string }
  | { kind: "compaction"; id: string; turnID: string }

export type ToolUse = { calls: number; errors: number; bytes: number }

/** One turn of one session, as the table keeps it. */
export type SessionMetricTurn = {
  sessionID: string
  turnID: string
  /** 1-based, in the order the harness first heard of the turn. */
  turn: number
  projectID?: string
  providerID?: string
  modelID?: string
  agent?: string
  /** Provider requests: one per model step. */
  requests: number
  tokens: MetricTokens
  cost: number
  /** Time spent in model steps, summed. */
  modelMs: number
  /** Time to the first output of the turn's first step. */
  firstTokenMs?: number
  toolCalls: number
  toolErrors: number
  toolOutputBytes: number
  tools: Record<string, ToolUse>
  compactions: number
  skills: string[]
  startedAt: number
  endedAt: number
  /** The session's holdout arms when the turn was first heard of (AH-B05). */
  arms?: Record<HoldoutCapability, Arm>
}

/** A turn's tools and skills are capped: a runaway session cannot grow a row without bound. */
const MAX_TOOLS = 50
const MAX_SKILLS = 20
const ID_LIMIT = 200
const NAME_LIMIT = 200
const PROJECT_LIMIT = 4096

export function emptyTurn(input: {
  sessionID: string
  turnID: string
  turn: number
  projectID?: string
  arms?: Record<HoldoutCapability, Arm>
  now: number
}): SessionMetricTurn {
  return {
    sessionID: input.sessionID,
    turnID: input.turnID,
    turn: input.turn,
    ...(input.projectID ? { projectID: input.projectID } : {}),
    requests: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    modelMs: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolOutputBytes: 0,
    tools: {},
    compactions: 0,
    skills: [],
    startedAt: input.now,
    endedAt: input.now,
    ...(input.arms ? { arms: input.arms } : {}),
  }
}

/** Folds one observation into its turn. Pure: the repository owns the dedupe and the write. */
export function applyObservation(turn: SessionMetricTurn, observation: MetricObservation, now: number): SessionMetricTurn {
  const endedAt = Math.max(turn.endedAt, now)
  if (observation.kind === "compaction") return { ...turn, compactions: turn.compactions + 1, endedAt }
  if (observation.kind === "tool") {
    const known = turn.tools[observation.tool]
    const tools =
      known || Object.keys(turn.tools).length < MAX_TOOLS
        ? {
            ...turn.tools,
            [observation.tool]: {
              calls: (known?.calls ?? 0) + 1,
              errors: (known?.errors ?? 0) + (observation.error ? 1 : 0),
              bytes: (known?.bytes ?? 0) + observation.bytes,
            },
          }
        : turn.tools
    const skill = observation.skill
    const skills =
      skill && !turn.skills.includes(skill) && turn.skills.length < MAX_SKILLS ? [...turn.skills, skill] : turn.skills
    return {
      ...turn,
      toolCalls: turn.toolCalls + 1,
      toolErrors: turn.toolErrors + (observation.error ? 1 : 0),
      toolOutputBytes: turn.toolOutputBytes + observation.bytes,
      tools,
      skills,
      endedAt,
    }
  }
  return {
    ...turn,
    // The latest step names the model: a turn that switched models reports the one that finished it.
    ...(observation.providerID ? { providerID: observation.providerID } : {}),
    ...(observation.modelID ? { modelID: observation.modelID } : {}),
    ...(observation.agent ? { agent: observation.agent } : {}),
    requests: turn.requests + 1,
    tokens: {
      input: turn.tokens.input + observation.tokens.input,
      output: turn.tokens.output + observation.tokens.output,
      reasoning: turn.tokens.reasoning + observation.tokens.reasoning,
      cacheRead: turn.tokens.cacheRead + observation.tokens.cacheRead,
      cacheWrite: turn.tokens.cacheWrite + observation.tokens.cacheWrite,
    },
    cost: turn.cost + observation.cost,
    modelMs: turn.modelMs + observation.ms,
    ...(turn.firstTokenMs === undefined && observation.firstTokenMs !== undefined
      ? { firstTokenMs: observation.firstTokenMs }
      : {}),
    // A step started before the harness heard of it: the turn began no later than that.
    startedAt: Math.min(turn.startedAt, now - observation.ms),
    endedAt,
  }
}

/** What the repository needs to record an observation. */
export type SessionMetricsStore = {
  recordSessionMetric(input: {
    sessionID: string
    projectID?: string
    arms?: Record<HoldoutCapability, Arm>
    observation: MetricObservation
  }): boolean
  listSessionMetrics(sessionID: string): SessionMetricTurn[]
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

/** The plugin's POST: validates the shape and records it. A duplicate is a 200 that records nothing. */
export async function handleSessionMetricsRequest(
  request: Request,
  store: SessionMetricsStore,
  arms?: (sessionID: string) => Record<HoldoutCapability, Arm>,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined)
  if (!isPlainObject(body)) return error("A metrics request needs a JSON body", "bad_request", 400)
  const sessionID = boundedString(body.sessionID, ID_LIMIT)
  if (sessionID === undefined) return error("A metrics request needs a sessionID", "bad_request", 400)
  const projectID = body.projectID === undefined ? undefined : boundedString(body.projectID, PROJECT_LIMIT)
  if (body.projectID !== undefined && projectID === undefined)
    return error("A metrics request carries a malformed projectID", "bad_request", 400)
  const observation = observationFrom(body.observation)
  if (observation === undefined)
    return error("A metrics request needs a well-formed step, tool or compaction", "bad_request", 400)
  const recorded = store.recordSessionMetric({
    sessionID,
    ...(projectID ? { projectID } : {}),
    ...(arms ? { arms: arms(sessionID) } : {}),
    observation,
  })
  return json({ data: { recorded } })
}

/** The browser's read: one session's turns, in order. */
export function handleSessionMetricsRead(request: Request, store: SessionMetricsStore): Response {
  const sessionID = boundedString(new URL(request.url).searchParams.get("sessionID"), ID_LIMIT)
  if (sessionID === undefined) return error("A metrics read needs a sessionID", "bad_request", 400)
  return json({ data: store.listSessionMetrics(sessionID) })
}

function observationFrom(value: unknown): MetricObservation | undefined {
  if (!isPlainObject(value)) return undefined
  const id = boundedString(value.id, ID_LIMIT)
  const turnID = boundedString(value.turnID, ID_LIMIT)
  if (id === undefined || turnID === undefined) return undefined
  if (value.kind === "compaction") return { kind: "compaction", id, turnID }
  if (value.kind === "tool") {
    const tool = boundedString(value.tool, NAME_LIMIT)
    const bytes = measure(value.bytes)
    if (tool === undefined || bytes === undefined || typeof value.error !== "boolean") return undefined
    const skill = boundedString(value.skill, NAME_LIMIT)
    return { kind: "tool", id, turnID, tool, error: value.error, bytes, ...(skill ? { skill } : {}) }
  }
  if (value.kind !== "step") return undefined
  const tokens = tokensFrom(value.tokens)
  const cost = measure(value.cost)
  const ms = measure(value.ms)
  if (tokens === undefined || cost === undefined || ms === undefined) return undefined
  const providerID = boundedString(value.providerID, NAME_LIMIT)
  const modelID = boundedString(value.modelID, NAME_LIMIT)
  const agent = boundedString(value.agent, NAME_LIMIT)
  const firstTokenMs = measure(value.firstTokenMs)
  return {
    kind: "step",
    id,
    turnID,
    ...(providerID ? { providerID } : {}),
    ...(modelID ? { modelID } : {}),
    ...(agent ? { agent } : {}),
    tokens,
    cost,
    ms,
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
  }
}

function tokensFrom(value: unknown): MetricTokens | undefined {
  if (!isPlainObject(value)) return undefined
  const input = measure(value.input)
  const output = measure(value.output)
  const reasoning = measure(value.reasoning)
  const cacheRead = measure(value.cacheRead)
  const cacheWrite = measure(value.cacheWrite)
  if (input === undefined || output === undefined || reasoning === undefined) return undefined
  if (cacheRead === undefined || cacheWrite === undefined) return undefined
  return { input, output, reasoning, cacheRead, cacheWrite }
}

function measure(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function boundedString(value: unknown, limit: number) {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
