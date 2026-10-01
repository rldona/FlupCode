import { createSignal } from "solid-js"
import { createClient } from "./client"
import type { InboxPrompt } from "./engine/contract"
import type { Attachment } from "./types"
import { toast } from "./toast"

/**
 * How a prompt sent while a turn is already running is delivered. `steer` joins the turn in flight at
 * its next boundary; `queue` waits until the session goes idle. Both go to the engine at once (V2-41):
 * a queued prompt waits in the session inbox, survives a reload, and is sent now or cancelled there.
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
  /** The engine holds it in the session inbox: Send now and Cancel go to the inbox. */
  held?: boolean
  /** Read from the inbox rather than sent from here, so the next read of it is the whole truth. */
  listed?: boolean
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

/** Asks the engine to steer a prompt it holds: it joins the running execution at its next boundary. */
const promote = (entry: PendingPrompt, serverUrl: string) => {
  unqueue(entry.id)
  void createClient(serverUrl)
    .session.inbox.update({ sessionID: entry.sessionID, inboxID: entry.id, delivery: "steer" })
    .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
}

/** Takes a prompt the engine holds back out of its inbox; it stays shown if the engine refuses. */
const withdraw = (entry: PendingPrompt, serverUrl: string) => {
  remove(entry.id)
  void createClient(serverUrl)
    .session.inbox.cancel({ sessionID: entry.sessionID, inboxID: entry.id })
    .catch((cause) => {
      add(entry)
      toast(cause instanceof Error ? cause.message : String(cause), "error")
    })
}

/**
 * Takes in what a session's inbox holds, which is how queued prompts outlive a reload or show
 * up from another window. A prompt sent from here and not listed yet is kept: it may simply not be
 * admitted at the time of the read. One read from the inbox before and missing now was delivered or
 * cancelled elsewhere.
 */
const adopt = (sessionID: string, prompts: InboxPrompt[]) =>
  setItems((list) => {
    const listed = new Map(prompts.map((prompt) => [prompt.id, prompt]))
    const kept = list.flatMap((entry) => {
      if (entry.sessionID !== sessionID || !entry.held) return [entry]
      const current = listed.get(entry.id)
      if (!current) return entry.listed ? [] : [entry]
      return [{ ...entry, delivery: current.delivery, listed: true }]
    })
    const known = new Set(kept.map((entry) => entry.id))
    return [
      ...kept,
      ...prompts
        .filter((prompt) => !known.has(prompt.id))
        .map((prompt) => ({
          id: prompt.id,
          sessionID,
          text: prompt.text,
          files: prompt.files,
          delivery: prompt.delivery,
          held: true,
          listed: true,
        })),
    ]
  })

const forSession = (
  sessionID: string | undefined,
  messages: Array<{ id: string }>,
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
        // Only a queued prompt has anything left to decide: a steered one is already running.
        sendNow: queued ? () => promote(entry, serverUrl) : undefined,
        cancel: queued ? () => withdraw(entry, serverUrl) : undefined,
      },
    ]
  })
}

export const pendingPrompts = { add, remove, reconcile, adopt, forSession }
