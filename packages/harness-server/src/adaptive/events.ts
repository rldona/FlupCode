/**
 * The engine signals an episode cannot derive from a tool's own hooks (FH-004).
 *
 * The `tool.execute.after` hook sees a call end whether or not it succeeded, but not why: a denied
 * permission or a failed edit only shows up as the engine's `message.part.updated` event with the
 * part in `error`, and a provider failure only as `session.error`. The plugin writes both into
 * `events/<sessionID>.json`, and this side turns them into the failures an episode cites.
 *
 * The file is read defensively, like `episode-signals`: an id that is not engine-shaped, unreadable
 * JSON, a malformed entry or a value past its limit degrades to the part that can be trusted, never
 * to a reader that throws.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { EpisodeFailure } from "./episode"

/** How many events are kept: the same ring the plugin writes, so a reader never sees more than it. */
export const MOST_EVENTS = 200

/** How much of an error message is kept, matching the plugin's own bound. */
export const EVENT_MESSAGE_LIMIT = 1000

export type EpisodeEvent =
  | { kind: "tool.error"; seq: number; at: number; tool: string; callID?: string; message: string }
  | { kind: "session.error"; seq: number; at: number; error: string; message: string }

export type EpisodeEvents = { events: EpisodeEvent[] }

/** Where the plugin writes, by the same rules it uses. */
export function episodeEventsDirectory(): string {
  const explicit = process.env.FLUPCODE_EPISODE_EVENTS_DIR
  if (explicit) return explicit
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "flupcode", "events")
}

/** The events a session left, or an empty set: a broken or missing file reads as nothing. */
export function episodeEvents(sessionID: string): EpisodeEvents {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return { events: [] }
  try {
    const parsed = JSON.parse(readFileSync(join(episodeEventsDirectory(), `${sessionID}.json`), "utf8")) as {
      events?: unknown
    }
    return { events: readEvents(parsed?.events) }
  } catch {
    return { events: [] }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const bounded = (value: string): string => value.slice(0, EVENT_MESSAGE_LIMIT)

/** Only the entries that can be read back whole; an unknown field is ignored, a malformed one dropped. */
function readEvents(value: unknown): EpisodeEvent[] {
  if (!Array.isArray(value)) return []
  return value.slice(-MOST_EVENTS).flatMap((entry): EpisodeEvent[] => {
    if (!isPlainObject(entry)) return []
    if (typeof entry.seq !== "number" || typeof entry.at !== "number") return []
    const message = typeof entry.message === "string" ? bounded(entry.message) : ""
    if (entry.kind === "tool.error") {
      if (typeof entry.tool !== "string" || !entry.tool) return []
      return [
        {
          kind: "tool.error",
          seq: entry.seq,
          at: entry.at,
          tool: entry.tool,
          ...(typeof entry.callID === "string" ? { callID: entry.callID } : {}),
          message,
        },
      ]
    }
    if (entry.kind === "session.error") {
      if (typeof entry.error !== "string" || !entry.error) return []
      return [{ kind: "session.error", seq: entry.seq, at: entry.at, error: entry.error, message }]
    }
    return []
  })
}

/** What the events left, as the failures the episode carries. */
export function failuresFromEvents(events: EpisodeEvent[]): EpisodeFailure[] {
  return events.map((event) =>
    event.kind === "tool.error"
      ? { summary: event.message ? `${event.tool} failed: ${event.message}` : `${event.tool} failed` }
      : { summary: event.message ? `${event.error}: ${event.message}` : event.error },
  )
}
