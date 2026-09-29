export * as SessionMessageCompat from "./message-compat"

import { Effect, Schema } from "effect"
import { SessionMessage } from "./message"

export interface Row {
  readonly id: string
  readonly type: string
  readonly data: unknown
}

const decodeUnknown = Schema.decodeUnknownEffect(SessionMessage.Message)
const decodeUnknownSync = Schema.decodeUnknownSync(SessionMessage.Message)

export const decodeMessage = (input: unknown): Effect.Effect<SessionMessage.Message, Schema.SchemaError> =>
  decodeUnknown(normalize(input))

export const decodeMessageSync = (input: unknown): SessionMessage.Message => decodeUnknownSync(normalize(input))

export const decodeRow = (row: Row): Effect.Effect<SessionMessage.Message, Schema.SchemaError> =>
  decodeMessage(envelope(row))

export const decodeRowSync = (row: Row): SessionMessage.Message => decodeMessageSync(envelope(row))

export const normalize = (input: unknown): unknown => {
  if (!isRecord(input)) return input
  if (input.type === "assistant") return normalizeAssistant(input)
  if (input.type === "user") return normalizeUser(input)
  return input
}

const envelope = (row: Row): unknown =>
  isRecord(row.data) ? { ...row.data, id: row.id, type: row.type } : { id: row.id, type: row.type }

function normalizeAssistant(input: Record<string, unknown>): Record<string, unknown> {
  const messageID = typeof input.id === "string" ? input.id : ""
  const content = Array.isArray(input.content)
    ? mapChanged(input.content, (part, index) => normalizeAssistantPart(part, messageID, index))
    : input.content
  const error = normalizeError(input.error, false)
  if (content === input.content && error === input.error) return input
  return {
    ...input,
    ...(content === input.content ? {} : { content }),
    ...(error === input.error ? {} : { error }),
  }
}

function normalizeAssistantPart(part: unknown, messageID: string, index: number): unknown {
  if (!isRecord(part)) return part
  const withId = normalizePartID(part, messageID, index)
  if (withId.type !== "tool") return withId
  const state = normalizeToolState(withId.state)
  if (state === withId.state) return withId
  return { ...withId, state }
}

function normalizePartID(part: Record<string, unknown>, messageID: string, index: number): Record<string, unknown> {
  const partType = part.type === "text" || part.type === "reasoning" || part.type === "tool"
  const hasID = typeof part.id === "string" && part.id.length > 0
  if (!partType || hasID) return part
  return { ...part, id: `compat_${messageID}_${index}` }
}

function normalizeToolState(state: unknown): unknown {
  if (!isRecord(state)) return state
  const shaped = state.status === "running" || state.status === "completed" || state.status === "error"
  const structured = shaped ? normalizeStructured(state) : state.structured
  const content = shaped && !Array.isArray(state.content) ? [] : state.content
  const error = normalizeError(state.error, state.status === "error")
  if (structured === state.structured && content === state.content && error === state.error) return state
  return {
    ...state,
    ...(structured === state.structured ? {} : { structured }),
    ...(content === state.content ? {} : { content }),
    ...(error === state.error ? {} : { error }),
  }
}

// Legacy tool states carry their structured output in `metadata`; the strict schema keeps it in `structured`.
function normalizeStructured(state: Record<string, unknown>): unknown {
  if (isRecord(state.structured)) return state.structured
  if (isRecord(state.metadata)) return state.metadata
  return {}
}

function normalizeError(error: unknown, inject: boolean): unknown {
  if (error === undefined) return inject ? { type: "unknown", message: "Unknown error" } : undefined
  if (isRecord(error) && error.type === "unknown" && typeof error.message === "string" && error.message.length > 0)
    return error
  return { type: "unknown", message: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error
  if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) return error.message
  return safeStringify(error)
}

// JSON.stringify throws on BigInt or circular structures and returns undefined for functions/symbols.
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined && json.length > 0) return json
  } catch {
    const fallback = String(value)
    if (fallback.length > 0) return fallback
  }
  return "Unknown error"
}

function normalizeUser(input: Record<string, unknown>): Record<string, unknown> {
  const files = Array.isArray(input.files) ? mapChanged(input.files, normalizeFile) : input.files
  const agents = Array.isArray(input.agents) ? mapChanged(input.agents, normalizeAgent) : input.agents
  if (files === input.files && agents === input.agents) return input
  return {
    ...input,
    ...(files === input.files ? {} : { files }),
    ...(agents === input.agents ? {} : { agents }),
  }
}

function normalizeAgent(agent: unknown): unknown {
  if (!isRecord(agent)) return agent
  const source = normalizeSource(agent.source)
  if (source === agent.source) return agent
  return source === undefined ? omit(agent, "source") : { ...agent, source }
}

function normalizeFile(file: unknown): unknown {
  if (!isRecord(file)) return file
  const source = normalizeSource(file.source)
  const hasUri = typeof file.uri === "string" && file.uri.length > 0
  const data = typeof file.data === "string" ? file.data : undefined
  const sourceChanged = source !== file.source
  if ((hasUri || data === undefined) && !sourceChanged) return file
  const cleaned = sourceChanged ? omit(omit(file, "data"), "source") : omit(file, "data")
  if (hasUri || data === undefined) return cleaned
  const mime = resolveMime(file, data)
  return {
    ...cleaned,
    uri: data.startsWith("data:") ? data : `data:${mime};base64,${data}`,
    mime,
  }
}

function normalizeSource(source: unknown): unknown {
  if (source === undefined) return undefined
  if (!isRecord(source)) return undefined
  if (typeof source.start !== "number" || typeof source.end !== "number" || typeof source.text !== "string")
    return undefined
  return source
}

function resolveMime(file: Record<string, unknown>, data: string): string {
  if (typeof file.mime === "string" && file.mime.length > 0) return file.mime
  if (data.startsWith("data:")) {
    const mime = /^data:([^;,]+)[;,]/.exec(data)?.[1]
    if (mime) return mime
  }
  return "application/octet-stream"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const omit = (input: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = input
  return rest
}

const mapChanged = (
  items: ReadonlyArray<unknown>,
  fn: (item: unknown, index: number) => unknown,
): ReadonlyArray<unknown> => {
  const mapped = items.map(fn)
  return mapped.some((item, index) => item !== items[index]) ? mapped : items
}
