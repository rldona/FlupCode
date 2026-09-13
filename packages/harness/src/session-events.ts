/**
 * Session events for split view panes. The app reads the engine's event streams once and republishes
 * what a pane needs, already normalised across the v2 stream and the chats folder's legacy stream.
 */

export type SessionEvent =
  /** Streamed text or reasoning of a running turn. */
  | { kind: "live"; sessionID: string; field: "text" | "reasoning"; delta: string }
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
