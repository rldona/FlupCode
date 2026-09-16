import { createSignal } from "solid-js"
import { createClient } from "./client"
import type { Attachment } from "./types"
import { toast } from "./toast"

/** How the engine takes a prompt sent while a turn is already running. `steer` promotes it at the
 *  next safe boundary of that turn; `queue` holds it until the session would otherwise go idle. */
export type Delivery = "steer" | "queue"

/** A prompt shown before the engine projects its message, with the delivery it was admitted under. */
export type PendingPrompt = {
  id: string
  sessionID: string
  text: string
  files: Attachment[]
  /** Undefined for a prompt that opened an idle session, where delivery makes no difference. */
  delivery?: Delivery
}

/** What SessionView renders for one prompt that is not a real message yet. */
export type SessionPending = {
  id: string
  text: string
  files: Attachment[]
  delivery?: Delivery
  sendNow?: () => void
}

// Shared by the single view and the split panes: keys by session, reconciles by message id.
const [items, setItems] = createSignal<PendingPrompt[]>([])

const add = (entry: PendingPrompt) => setItems((list) => [...list, entry])

const remove = (id: string) => setItems((list) => list.filter((entry) => entry.id !== id))

const unqueue = (id: string) =>
  setItems((list) => list.map((entry) => (entry.id === id ? { ...entry, delivery: "steer" as const } : entry)))

/** Drops prompts whose real message has arrived, so the list cannot grow. */
const reconcile = (ids: Set<string>) =>
  setItems((list) => (list.some((entry) => ids.has(entry.id)) ? list.filter((entry) => !ids.has(entry.id)) : list))

const dispatch = (entry: PendingPrompt, expand: (text: string) => string, serverUrl: string) => {
  void createClient(serverUrl)
    .session.prompt({
      sessionID: entry.sessionID,
      id: entry.id,
      text: expand(entry.text),
      ...(entry.files.length > 0 ? { files: entry.files.map(({ uri, name }) => ({ uri, name })) } : {}),
      delivery: "steer",
    })
    .catch((cause) => {
      remove(entry.id)
      toast(cause instanceof Error ? cause.message : String(cause), "error")
    })
}

// Interrupting ends the running turn; re-sending the same prompt id reconciles the already admitted
// input and wakes the run so it starts as soon as the turn stops.
const sendNow = (entry: PendingPrompt, expand: (text: string) => string, serverUrl: string) => {
  unqueue(entry.id)
  void createClient(serverUrl)
    .session.interrupt({ sessionID: entry.sessionID })
    .catch(() => undefined)
    .then(() => dispatch(entry, expand, serverUrl))
}

const forSession = (
  sessionID: string | undefined,
  messages: Array<{ id: string }>,
  expand: (text: string) => string,
  serverUrl: string,
): SessionPending[] => {
  if (!sessionID) return []
  return items().flatMap((entry) => {
    if (entry.sessionID !== sessionID || messages.some((message) => message.id === entry.id)) return []
    return [
      {
        id: entry.id,
        text: entry.text,
        files: entry.files,
        delivery: entry.delivery,
        sendNow: entry.delivery === "queue" ? () => sendNow(entry, expand, serverUrl) : undefined,
      },
    ]
  })
}

export const pendingPrompts = { add, remove, reconcile, forSession }
