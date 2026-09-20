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
  parentID?: string
  providerID?: string
  modelID?: string
  error?: unknown
  /** The engine's compaction writes its summary as an assistant message flagged this way. */
  summary?: boolean
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
  /** On a `compaction` part: whether the engine compacted on its own or because it was asked to. */
  auto?: boolean
  overflow?: boolean
  time?: { start?: number; end?: number }
  state?: { status?: string; input?: unknown; output?: string; error?: string; time?: { compacted?: number } }
}

export type LegacyEntry = { info: LegacyInfo; parts: LegacyPart[] }

const created = (message: SessionMessageInfo) => (message as { time?: { created?: number } }).time?.created ?? 0

/** One legacy part as a v2 content entry, or nothing for the parts the views do not render. */
export function contentOf(part: LegacyPart) {
  // `streaming` says the part is still arriving, which is what lets the renderer highlight as it
  // goes instead of re-parsing the whole block on every slice.
  const streaming = !!part.time?.start && !part.time.end
  if (part.type === "text") return { type: "text", id: part.id, text: part.text ?? "", streaming }
  if (part.type === "reasoning") return { type: "reasoning", id: part.id, text: part.text ?? "", streaming }
  if (part.type !== "tool") return undefined
  return {
    type: "tool",
    id: part.id,
    name: part.tool ?? "",
    // A pruned result is one the engine dropped from the context it sends. The legacy store keeps
    // that on the tool state; v2 keeps it on the part, which is where the views read it.
    time: { created: part.time?.start ?? 0, pruned: part.state?.time?.compacted },
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
    // A compaction starts as a user message whose only part is the marker: it carries whether the
    // engine compacted by itself. It is not a prompt, so the view draws it as a marker, not as "You".
    const compaction = parts.find((part) => part.type === "compaction")
    return {
      id: info.id,
      type: "user",
      time: info.time,
      text: parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
      ...(files.length > 0 ? { files } : {}),
      ...(compaction ? { compaction: { auto: compaction.auto === true, overflow: compaction.overflow === true } } : {}),
    } as unknown as SessionMessageInfo
  }
  return {
    id: info.id,
    type: "assistant",
    time: info.time,
    agent: info.agent,
    parentID: info.parentID,
    // The engine's own compaction writes the summary as an assistant message with this flag.
    ...(info.summary === true ? { summary: true } : {}),
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
 * Parts the engine sent before the message they belong to. The engine announces the message first,
 * but the event bus can deliver a part first, and a part dropped on the floor left the prompt blank
 * until the next refetch rebuilt it — the reload that finally showed it. Bounded: a message that
 * never arrives would otherwise hold its parts for the life of the tab.
 */
const ORPHANED_PARTS = new Map<string, LegacyPart[]>()
const ORPHANED_PART_MESSAGES = 64

function orphanPart(part: LegacyPart) {
  const messageID = part.messageID
  if (!messageID) return
  const held = ORPHANED_PARTS.get(messageID)
  if (held) {
    held.push(part)
    return
  }
  ORPHANED_PARTS.set(messageID, [part])
  if (ORPHANED_PARTS.size <= ORPHANED_PART_MESSAGES) return
  const oldest = ORPHANED_PARTS.keys().next().value
  if (oldest !== undefined) ORPHANED_PARTS.delete(oldest)
}

function takeOrphanedParts(messageID: string) {
  const held = ORPHANED_PARTS.get(messageID)
  ORPHANED_PARTS.delete(messageID)
  return held ?? []
}

/**
 * A message the engine created or changed. Its parts are not in the event, so the ones already in
 * the transcript are kept, and any part that raced ahead of it is folded in now.
 */
export function applyMessage(data: SessionMessageInfo[], info: LegacyInfo) {
  const existing = data.find((entry) => entry.id === info.id)
  if (!existing) return withMessage(data, messageOf(info, takeOrphanedParts(info.id)))
  const next = messageOf(info, [])
  if (info.role === "user") return withMessage(data, asMessage({ ...next, ...pickUserContent(existing) }))
  return withMessage(data, asMessage({ ...next, content: (existing as { content?: unknown[] }).content ?? [] }))
}

function pickUserContent(existing: SessionMessageInfo) {
  const entry = existing as { text?: string; files?: unknown }
  return { ...(entry.text ? { text: entry.text } : {}), ...(entry.files ? { files: entry.files } : {}) }
}

/** A part the engine created or changed, placed in its message in the order the engine sent it. */
export function applyPart(data: SessionMessageInfo[], part: LegacyPart) {
  if (!part.messageID) return data
  // The message has to exist before its part can be placed in it. A part that arrives first is held
  // instead of dropped: the message event folds it in when it lands.
  if (!data.some((message) => message.id === part.messageID)) {
    orphanPart(part)
    return data
  }
  const entry = contentOf(part)
  return data.map((message) => {
    if (message.id !== part.messageID) return message
    // A user message keeps its text and files flat instead of as `content`. The engine announces the
    // user message empty and sends the text part right after, so without this its prompt stayed
    // blank for the whole turn and only a refetch rebuilt it from the parts — the reload that made
    // the message appear. See `messageOf` for the same mapping over a whole history.
    if (message.type === "user") return withUserPart(message, part)
    if (!entry) return message
    const content = ((message as { content?: Array<{ id?: string }> }).content ?? []).slice()
    const index = content.findIndex((item) => item.id === part.id)
    if (index === -1) content.push(entry as { id?: string })
    else content[index] = entry as { id?: string }
    return asMessage({ ...message, content })
  })
}

/**
 * One part of a user message. The composer sends a single text part per prompt, so the part's text
 * is the message's text; a file part adds an attachment, deduplicated by url because the same part
 * can be announced more than once.
 */
function withUserPart(message: SessionMessageInfo, part: LegacyPart) {
  if (part.type === "text") return asMessage({ ...message, text: part.text ?? "" })
  if (part.type === "compaction")
    return asMessage({ ...message, compaction: { auto: part.auto === true, overflow: part.overflow === true } })
  if (part.type !== "file" || !part.url) return message
  const files = ((message as { files?: Array<{ uri: string; name?: string }> }).files ?? []).slice()
  if (!files.some((file) => file.uri === part.url)) files.push({ uri: part.url, name: part.filename ?? part.url })
  return asMessage({ ...message, files })
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
  // A removed message takes any part that was waiting for it; otherwise the buffer would hold parts
  // for a message that is never coming.
  ORPHANED_PARTS.delete(messageID)
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

/**
 * Put one message change into a transcript store.
 *
 * A turn is almost entirely deltas — measured against the engine on 2026-09-16, 5132 of the 5330
 * events of a 150s turn, some 34 a second. Running each one through `applyDelta` walks every
 * message and allocates a new object for the one it changes, so the cost of a single character
 * grows with the length of the session; at 316 messages and 1230 parts the main thread stopped
 * answering, and the window stopped scrolling until the turn ended.
 *
 * Solid can write to a path inside the store, touching one part and telling only what reads it, so
 * a delta costs the same on the first message of a session as on the thousandth. Everything else —
 * a part appearing, a message arriving, either being removed — is rare enough to keep going through
 * the pure functions above, which is also what keeps them testable.
 */
export function applyTranscriptChange(
  setStore: (path: "data", ...rest: unknown[]) => void,
  change: {
    apply: (data: SessionMessageInfo[]) => SessionMessageInfo[]
    delta?: { messageID: string; partID: string; text: string }
  },
) {
  const delta = change.delta
  if (!delta) return setStore("data", (current: SessionMessageInfo[]) => change.apply(current))
  setStore(
    "data",
    (message: SessionMessageInfo) => message.id === delta.messageID && message.type === "assistant",
    "content",
    (part: { id?: string; type?: string }) =>
      part.id === delta.partID && (part.type === "text" || part.type === "reasoning"),
    "text",
    (text: string | undefined) => `${text ?? ""}${delta.text}`,
  )
}
