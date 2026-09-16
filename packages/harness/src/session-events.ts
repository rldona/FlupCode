/**
 * Session events for split view panes. The app reads the engine's event streams once and republishes
 * what a pane needs, already normalised across the v2 stream and the chats folder's legacy stream.
 */

import type { SessionMessageInfo } from "./engine-types"

export type SessionEvent =
  /**
   * One message mutation from the engine, as a function over the transcript. The app reads the
   * stream once and hands every view the same change, so a pane and the main view stay identical
   * without either of them refetching the whole history. `chars` is what this event added, which is
   * all the loader needs to estimate the tokens of a turn still running.
   */
  | {
      kind: "message"
      sessionID: string
      apply: (data: SessionMessageInfo[]) => SessionMessageInfo[]
      chars: number
      /**
       * Set when the change is one part growing by one slice, which is all but a handful of the
       * events of a turn. `apply` rebuilds the whole transcript to do it, which costs more the
       * longer the session gets; with this a view can write straight to the part instead. See
       * `applyTranscriptChange`.
       */
      delta?: { messageID: string; partID: string; text: string }
    }
  /** A new turn started: what streamed before is stale. */
  | { kind: "turn"; sessionID: string }
  /** Messages changed; without a session, any session may have. */
  | { kind: "changed"; sessionID?: string }
  /** Permission or question requests changed. */
  | { kind: "requests" }

const listeners = new Set<(event: SessionEvent) => void>()

export function publishSessionEvent(event: SessionEvent) {
  for (const listener of listeners) listener(event)
}

export function subscribeSessionEvents(listener: (event: SessionEvent) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
