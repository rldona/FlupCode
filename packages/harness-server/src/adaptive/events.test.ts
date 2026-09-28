import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EVENT_MESSAGE_LIMIT,
  MOST_EVENTS,
  episodeEvents,
  episodeEventsDirectory,
  failuresFromEvents,
} from "./events"
import type { EpisodeEvent } from "./events"

const dirs: string[] = []
const eventsDir = async () => {
  const dir = mkdtempSync(join(tmpdir(), "flupcode-events-"))
  dirs.push(dir)
  process.env.FLUPCODE_EPISODE_EVENTS_DIR = dir
  return dir
}

const writeEvents = (dir: string, sessionID: string, data: unknown) =>
  writeFileSync(join(dir, `${sessionID}.json`), typeof data === "string" ? data : JSON.stringify(data))

afterEach(() => {
  delete process.env.FLUPCODE_EPISODE_EVENTS_DIR
  delete process.env.XDG_DATA_HOME
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("episodeEventsDirectory", () => {
  test("follows the env, then XDG, then the home default", () => {
    process.env.FLUPCODE_EPISODE_EVENTS_DIR = "/custom/events"
    expect(episodeEventsDirectory()).toBe("/custom/events")

    delete process.env.FLUPCODE_EPISODE_EVENTS_DIR
    process.env.XDG_DATA_HOME = "/xdg"
    expect(episodeEventsDirectory()).toBe(join("/xdg", "flupcode", "events"))
  })
})

describe("episodeEvents", () => {
  test("reads a tool error and a session error back in order", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      at: 1,
      events: [
        { kind: "tool.error", seq: 10, at: 10, tool: "edit", callID: "call_1", message: "permission denied" },
        { kind: "session.error", seq: 11, at: 11, error: "APIError", message: "rate limited" },
      ],
    })

    const { events } = episodeEvents("ses_a")
    expect(events).toEqual([
      { kind: "tool.error", seq: 10, at: 10, tool: "edit", callID: "call_1", message: "permission denied" },
      { kind: "session.error", seq: 11, at: 11, error: "APIError", message: "rate limited" },
    ])
  })

  test("a corrupt file, a missing one or an invalid id all read as no events", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_bad", "{ this is not json")
    expect(episodeEvents("ses_bad")).toEqual({ events: [] })
    expect(episodeEvents("ses_missing")).toEqual({ events: [] })
    expect(episodeEvents("../escape")).toEqual({ events: [] })
  })

  test("unknown fields and malformed entries are ignored, not guessed at", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      at: 1,
      extra: "ignored",
      events: [
        "noise",
        { kind: "tool.error", seq: 1, at: 1 },
        { kind: "session.error", seq: 2, at: 2 },
        { kind: "other", seq: 3, at: 3, tool: "edit", message: "x" },
        { kind: "tool.error", seq: 4, tool: "edit", message: "no clock" },
        { kind: "tool.error", seq: 5, at: 5, tool: "edit", message: "kept", future: { nested: true } },
      ],
    })

    expect(episodeEvents("ses_a").events).toEqual([
      { kind: "tool.error", seq: 5, at: 5, tool: "edit", message: "kept" },
    ])
  })

  test("a callID that is not a string is dropped rather than guessed at", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      events: [{ kind: "tool.error", seq: 1, at: 1, tool: "edit", callID: 7, message: "x" }],
    })

    const [event] = episodeEvents("ses_a").events
    expect(event).toEqual({ kind: "tool.error", seq: 1, at: 1, tool: "edit", message: "x" })
  })

  test("the file's own order is authoritative: the reader never reorders by seq", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      events: [
        { kind: "tool.error", seq: 9, at: 9, tool: "edit", message: "first" },
        { kind: "tool.error", seq: 3, at: 3, tool: "bash", message: "second" },
        { kind: "session.error", seq: 7, at: 7, error: "APIError", message: "third" },
      ],
    })

    const { events } = episodeEvents("ses_a")
    expect(events.map((event) => event.message)).toEqual(["first", "second", "third"])
    expect(events.map((event) => event.seq)).toEqual([9, 3, 7])
  })

  test("a file past the ring is read back to its newest two hundred events", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      events: Array.from({ length: 5000 }, (_, index) => ({
        kind: "tool.error",
        seq: index,
        at: index,
        tool: "edit",
        message: `boom-${index}`,
      })),
    })

    const { events } = episodeEvents("ses_a")
    expect(events).toHaveLength(MOST_EVENTS)
    expect(events[0]!.kind === "tool.error" && events[0]!.message).toBe("boom-4800")
    expect(events[MOST_EVENTS - 1]!.kind === "tool.error" && events[MOST_EVENTS - 1]!.message).toBe("boom-4999")
  })

  test("a message past its limit is clamped when it is read back", async () => {
    const dir = await eventsDir()
    writeEvents(dir, "ses_a", {
      events: [
        { kind: "tool.error", seq: 1, at: 1, tool: "edit", message: "m".repeat(EVENT_MESSAGE_LIMIT * 2) },
        { kind: "session.error", seq: 2, at: 2, error: "APIError", message: "e".repeat(EVENT_MESSAGE_LIMIT * 2) },
      ],
    })

    const { events } = episodeEvents("ses_a")
    expect(events[0]!.message).toHaveLength(EVENT_MESSAGE_LIMIT)
    expect(events[1]!.message).toHaveLength(EVENT_MESSAGE_LIMIT)
  })
})

describe("failuresFromEvents", () => {
  test("names the tool and the session error, with and without a message", () => {
    const events: EpisodeEvent[] = [
      { kind: "tool.error", seq: 1, at: 1, tool: "edit", callID: "call_1", message: "permission denied" },
      { kind: "tool.error", seq: 2, at: 2, tool: "bash", message: "" },
      { kind: "session.error", seq: 3, at: 3, error: "APIError", message: "rate limited" },
      { kind: "session.error", seq: 4, at: 4, error: "ProviderAuthError", message: "" },
    ]

    expect(failuresFromEvents(events)).toEqual([
      { summary: "edit failed: permission denied" },
      { summary: "bash failed" },
      { summary: "APIError: rate limited" },
      { summary: "ProviderAuthError" },
    ])
  })

  test("carries no file or line: an event names no place to anchor on", () => {
    const [failure] = failuresFromEvents([
      { kind: "tool.error", seq: 1, at: 1, tool: "edit", message: "permission denied" },
    ])
    expect(failure).toEqual({ summary: "edit failed: permission denied" })
  })
})
