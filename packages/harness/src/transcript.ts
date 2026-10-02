import type { SessionMessageInfo } from "./engine-types"

/**
 * Changes to the transcript the app renders, applied as the engine streams them (V2-21) instead of
 * reading the whole history again.
 */

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
    return { ...message, content: next } as unknown as SessionMessageInfo
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
 * the change's own `apply`, which is also what keeps it testable.
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
