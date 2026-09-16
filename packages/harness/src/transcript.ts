import type { SessionMessageInfo } from "./engine-types"

/**
 * The legacy runtime — the one Code runs on — keeps a message and its parts apart, and streams them
 * as separate events. The views want the v2 shape, where an assistant message carries its parts as
 * `content`. This module is the one place that maps between the two, for a whole history and for a
 * single event, so a transcript built by applying events is the same transcript a refetch returns.
 */

export type LegacyInfo = {
  id: string
  sessionID?: string
  role: string
  agent?: string
  providerID?: string
  modelID?: string
  error?: unknown
  time?: { created?: number; completed?: number }
  tokens?: unknown
  cost?: number
}

export type LegacyPart = {
  id: string
  messageID?: string
  type: string
  text?: string
  tool?: string
  url?: string
  filename?: string
  mime?: string
  state?: { status?: string; input?: unknown; output?: string; error?: string }
}

export type LegacyEntry = { info: LegacyInfo; parts: LegacyPart[] }

const created = (message: SessionMessageInfo) => (message as { time?: { created?: number } }).time?.created ?? 0

/** One legacy part as a v2 content entry, or nothing for the parts the views do not render. */
export function contentOf(part: LegacyPart) {
  if (part.type === "text") return { type: "text", id: part.id, text: part.text ?? "" }
  if (part.type === "reasoning") return { type: "reasoning", id: part.id, text: part.text ?? "" }
  if (part.type !== "tool") return undefined
  return {
    type: "tool",
    id: part.id,
    name: part.tool ?? "",
    state: {
      status: part.state?.status,
      input: part.state?.input,
      content: part.state?.status === "completed" ? [{ type: "text", text: part.state.output ?? "" }] : undefined,
      error: part.state?.status === "error" ? { message: part.state.error } : undefined,
    },
  }
}

/** The attachments of a user message, which the composer sent as file parts. */
function filesOf(parts: LegacyPart[]) {
  return parts
    .filter((part) => part.type === "file" && !!part.url)
    .map((part) => ({ uri: part.url!, name: part.filename ?? part.url! }))
}

export function messageOf(info: LegacyInfo, parts: LegacyPart[]): SessionMessageInfo {
  if (info.role === "user") {
    const files = filesOf(parts)
    return {
      id: info.id,
      type: "user",
      time: info.time,
      text: parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
      ...(files.length > 0 ? { files } : {}),
    } as unknown as SessionMessageInfo
  }
  return {
    id: info.id,
    type: "assistant",
    time: info.time,
    agent: info.agent,
    model: info.modelID ? { providerID: info.providerID, id: info.modelID } : undefined,
    content: parts.flatMap((part) => {
      const entry = contentOf(part)
      return entry ? [entry] : []
    }),
    error: info.error,
    tokens: info.tokens,
    cost: info.cost,
  } as unknown as SessionMessageInfo
}

export function fromLegacy(entries: LegacyEntry[]): SessionMessageInfo[] {
  return entries.map((entry) => messageOf(entry.info, entry.parts ?? []))
}

/**
 * A session can hold history in both message stores: the legacy one (written by the TUI, and by
 * every turn this app runs) and v2 (written by prompts from before H-01). They never share
 * messages, so show both in order.
 */
export function mergeTranscripts(v2: SessionMessageInfo[], legacy: SessionMessageInfo[]) {
  if (legacy.length === 0) return v2
  if (v2.length === 0) return legacy
  return [...legacy, ...v2]
    .map((message, index) => ({ message, index }))
    .sort((a, b) => created(a.message) - created(b.message) || a.index - b.index)
    .map((entry) => entry.message)
}

/** The engine's message union is far wider than what a legacy event can produce, so the few places
 *  that rebuild a message from one hand the result back through this. */
const asMessage = (value: unknown) => value as SessionMessageInfo

const withMessage = (data: SessionMessageInfo[], message: SessionMessageInfo) => {
  const index = data.findIndex((entry) => entry.id === message.id)
  if (index === -1) return [...data, message]
  return data.map((entry, at) => (at === index ? message : entry))
}

/**
 * A message the engine created or changed. Its parts are not in the event, so the ones already in
 * the transcript are kept: the engine announces the message first and its parts afterwards.
 */
export function applyMessage(data: SessionMessageInfo[], info: LegacyInfo) {
  const existing = data.find((entry) => entry.id === info.id)
  const next = messageOf(info, [])
  if (!existing) return withMessage(data, next)
  if (info.role === "user") return withMessage(data, asMessage({ ...next, ...pickUserContent(existing) }))
  return withMessage(data, asMessage({ ...next, content: (existing as { content?: unknown[] }).content ?? [] }))
}

function pickUserContent(existing: SessionMessageInfo) {
  const entry = existing as { text?: string; files?: unknown }
  return { ...(entry.text ? { text: entry.text } : {}), ...(entry.files ? { files: entry.files } : {}) }
}

/** A part the engine created or changed, placed in its message in the order the engine sent it. */
export function applyPart(data: SessionMessageInfo[], part: LegacyPart) {
  const entry = contentOf(part)
  if (!entry || !part.messageID) return data
  return data.map((message) => {
    if (message.id !== part.messageID || message.type !== "assistant") return message
    const content = ((message as { content?: Array<{ id?: string }> }).content ?? []).slice()
    const index = content.findIndex((item) => item.id === part.id)
    if (index === -1) content.push(entry as { id?: string })
    else content[index] = entry as { id?: string }
    return asMessage({ ...message, content })
  })
}

/**
 * A slice of text for a part that is still streaming. The engine sends deltas for a part it has
 * already announced, but a dropped frame or a reconnection can leave a delta with nothing to append
 * to, so an unknown part is ignored rather than invented: the next full part update carries the
 * whole text anyway.
 */
export function applyDelta(data: SessionMessageInfo[], input: { messageID?: string; partID?: string; delta?: string }) {
  if (!input.messageID || !input.partID || !input.delta) return data
  return data.map((message) => {
    if (message.id !== input.messageID || message.type !== "assistant") return message
    const content = (message as { content?: Array<{ id?: string; type?: string; text?: string }> }).content ?? []
    const index = content.findIndex((item) => item.id === input.partID)
    if (index === -1) return message
    const part = content[index]!
    if (part.type !== "text" && part.type !== "reasoning") return message
    const next = content.slice()
    next[index] = { ...part, text: `${part.text ?? ""}${input.delta}` }
    return asMessage({ ...message, content: next })
  })
}

export function removeMessage(data: SessionMessageInfo[], messageID: string) {
  return data.some((entry) => entry.id === messageID) ? data.filter((entry) => entry.id !== messageID) : data
}

export function removePart(data: SessionMessageInfo[], input: { messageID?: string; partID?: string }) {
  if (!input.messageID || !input.partID) return data
  return data.map((message) => {
    if (message.id !== input.messageID || message.type !== "assistant") return message
    const content = (message as { content?: Array<{ id?: string }> }).content ?? []
    if (!content.some((item) => item.id === input.partID)) return message
    return asMessage({ ...message, content: content.filter((item) => item.id !== input.partID) })
  })
}
