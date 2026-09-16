import { createSignal } from "solid-js"
import { createClient } from "./client"
import type { Attachment } from "./types"
import { toast } from "./toast"

/**
 * How a prompt sent while a turn is already running is delivered. `steer` goes to the engine at
 * once and joins the turn in flight at its next boundary; `queue` waits here until the session goes
 * idle. The waiting is the harness's job because the legacy runtime — the one that has subagents,
 * MCP, LSP and retries, and therefore the one Code runs on — has no queue of its own: a prompt sent
 * to a busy session is picked up by the running loop, never held back.
 */
export type Delivery = "steer" | "queue"

/** A prompt shown before the engine projects its message, with the delivery it was admitted under. */
export type PendingPrompt = {
  id: string
  sessionID: string
  directory?: string
  text: string
  files: Attachment[]
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
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
  cancel?: () => void
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
  unqueue(entry.id)
  void createClient(serverUrl)
    .session.send({
      sessionID: entry.sessionID,
      directory: entry.directory,
      id: entry.id,
      text: expand(entry.text),
      agent: entry.agent,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.files.length > 0 ? { files: entry.files.map(({ uri, name }) => ({ uri, name })) } : {}),
    })
    .catch((cause) => {
      remove(entry.id)
      toast(cause instanceof Error ? cause.message : String(cause), "error")
    })
}

/**
 * Sends the prompt that has been waiting the longest for this session, if any. The caller decides
 * when: a session that has just gone idle is the only safe moment, because anything sent earlier
 * would be swallowed by the turn that is still running.
 */
const release = (sessionID: string, expand: (text: string) => string, serverUrl: string) => {
  const next = items().find((entry) => entry.sessionID === sessionID && entry.delivery === "queue")
  if (next) dispatch(next, expand, serverUrl)
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
    const queued = entry.delivery === "queue"
    return [
      {
        id: entry.id,
        text: entry.text,
        files: entry.files,
        delivery: entry.delivery,
        // Only a queued prompt has anything left to decide: a steered one is already with the engine.
        sendNow: queued ? () => dispatch(entry, expand, serverUrl) : undefined,
        cancel: queued ? () => remove(entry.id) : undefined,
      },
    ]
  })
}

export const pendingPrompts = { add, remove, reconcile, release, forSession }
