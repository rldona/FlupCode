/**
 * The pure selection behind CACHE_SELECTION_PLUGIN (AH-D03, ADR-0024), as plain JavaScript source. It
 * is inlined into the plugin, which may import no package, and tests evaluate the same text, so the
 * code the engine runs is the code the tests prove.
 *
 * `selectForCache(messages, policy)` takes the engine's `{ info, parts }` list and returns
 * `{ messages, trimmed, savedTokens }`. It never mutates its input: an untouched message keeps its
 * object, a message with a trimmed part is a shallow copy. Only the output of a completed tool part is
 * ever replaced, so every tool call keeps its result and no message or part is added or removed.
 *
 * Prompt caching decides everything here: the provider caches the request prefix, so changing a byte
 * the previous request already sent rewrites everything after it at the cache-write price. The trimmed
 * set therefore changes only at a **cold boundary**, a user message sent after the conversation's
 * cache has expired (the gap since the previous assistant message completed is past `coldGapMs`),
 * where the whole conversation is written again anyway. The set is a function of the history before
 * each boundary, so every later step reproduces it byte for byte until the next boundary.
 */
export const CACHE_SELECTION_SOURCE = String.raw`// Tools whose whole output stays the point long after the call: a loaded skill's instructions, a
// subagent's answer and the todo list. They are never trimmed.
const SELECTION_EXEMPT_TOOLS = ["skill", "task", "todowrite", "todoread"]

// Outputs shorter than this save less than the placeholder costs to read; they are left alone.
const SELECTION_MIN_OUTPUT_CHARS = 1024

const SELECTION_REF = /^[0-9a-f]{16}$/
const SELECTION_REF_IN_OUTPUT = /evidence:([0-9a-f]{16})/

// The engine's own estimate: four characters a token.
function selectionTokens(text) {
  return Math.ceil(text.length / 4)
}

// A user message is a cold boundary when the message right before it is an assistant message that
// completed more than coldGapMs before the user message was created. The request that sends it goes
// out no earlier than that, so its conversation cache has expired: nothing it trims was cached. A user
// message after another user message, or after an assistant message without a completion time, is
// never a boundary, so a race between a queued message and a running step cannot move the set.
function coldBoundary(messages, index, coldGapMs) {
  const info = messages[index] && messages[index].info
  const before = index > 0 && messages[index - 1] ? messages[index - 1].info : undefined
  if (!info || info.role !== "user" || !before || before.role !== "assistant") return false
  const created = info.time && info.time.created
  const completed = before.time && before.time.completed
  return typeof created === "number" && typeof completed === "number" && created - completed > coldGapMs
}

// Whether the step this list is sent on is cold: its last message opens a turn at a cold boundary.
function coldStep(messages, coldGapMs) {
  return Array.isArray(messages) && messages.length > 0 && coldBoundary(messages, messages.length - 1, coldGapMs)
}

function selectionRef(state) {
  const held = state.metadata && typeof state.metadata === "object" ? state.metadata.evidenceRef : undefined
  if (typeof held === "string" && SELECTION_REF.test(held)) return held
  const found = SELECTION_REF_IN_OUTPUT.exec(state.output)
  return found ? found[1] : undefined
}

// The placeholder depends only on the part, so every later step renders the same bytes.
function selectionPlaceholder(part) {
  const ref = selectionRef(part.state)
  return (
    "[Old " + part.tool + " output (" + part.state.output.length + " characters) cleared by FlupCode to save context. " +
    (ref ? "The full output is kept: call evidence_read with ref " + ref + "." : "Run the tool again if you still need it.") +
    "]"
  )
}

function selectionTrimmable(part) {
  if (!part || part.type !== "tool" || typeof part.tool !== "string") return false
  if (SELECTION_EXEMPT_TOOLS.includes(part.tool)) return false
  const state = part.state
  if (!state || state.status !== "completed" || typeof state.output !== "string") return false
  // The engine's own prune already clears a compacted output; touching it again would change nothing.
  if (state.time && state.time.compacted) return false
  return state.output.length >= SELECTION_MIN_OUTPUT_CHARS
}

function selectForCache(messages, policy) {
  const trimmed = new Map()
  const users = []
  let savedTokens = 0
  messages.forEach((message, boundary) => {
    const isUser = message && message.info && message.info.role === "user"
    if (!coldBoundary(messages, boundary, policy.coldGapMs)) {
      if (isUser) users.push(boundary)
      return
    }
    // The last keepRecentTurns turns before the boundary stay whole; a turn starts at a user message.
    const keep = policy.keepRecentTurns
    const protectedFrom = keep === 0 ? boundary : users.length >= keep ? users[users.length - keep] : 0
    users.push(boundary)
    const candidates = messages.slice(0, protectedFrom).flatMap((candidate, index) => {
      if (!candidate || !candidate.info || candidate.info.role !== "assistant" || !Array.isArray(candidate.parts)) return []
      return candidate.parts.flatMap((part, at) => {
        if (!selectionTrimmable(part) || (trimmed.get(index) && trimmed.get(index).has(at))) return []
        const saving = selectionTokens(part.state.output) - selectionTokens(selectionPlaceholder(part))
        return saving > 0 ? [{ index: index, at: at, saving: saving }] : []
      })
    })
    const saving = candidates.reduce((sum, candidate) => sum + candidate.saving, 0)
    // Below the floor the information lost is not worth the tokens: this boundary trims nothing new.
    if (candidates.length === 0 || saving < policy.minSavingsTokens) return
    candidates.forEach((candidate) => {
      if (!trimmed.has(candidate.index)) trimmed.set(candidate.index, new Set())
      trimmed.get(candidate.index).add(candidate.at)
    })
    savedTokens += saving
  })
  if (trimmed.size === 0) return { messages: messages, trimmed: 0, savedTokens: 0 }
  const selected = messages.map((message, index) => {
    const parts = trimmed.get(index)
    if (!parts) return message
    return {
      ...message,
      parts: message.parts.map((part, at) => {
        if (!parts.has(at)) return part
        // Attachments go with the output they belong to, as the engine's own prune does.
        const state = { ...part.state, output: selectionPlaceholder(part) }
        if (Array.isArray(state.attachments)) state.attachments = []
        return { ...part, state: state }
      }),
    }
  })
  return {
    messages: selected,
    trimmed: [...trimmed.values()].reduce((sum, parts) => sum + parts.size, 0),
    savedTokens: savedTokens,
  }
}`
