import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "./engine-types"
import {
  applyDelta,
  applyMessage,
  applyPart,
  fromLegacy,
  mergeTranscripts,
  removeMessage,
  removePart,
} from "./transcript"

const message = (id: string, type: string, created: number) =>
  ({ id, type, time: { created } }) as unknown as SessionMessageInfo

describe("mergeTranscripts", () => {
  test("keeps the legacy history when a session continues in v2", () => {
    const legacy = [message("l1", "user", 1), message("l2", "assistant", 2), message("l3", "user", 3)]
    const v2 = [message("v1", "user", 10), message("v2", "assistant", 11)]
    expect(mergeTranscripts(v2, legacy).map((entry: SessionMessageInfo) => entry.id)).toEqual([
      "l1",
      "l2",
      "l3",
      "v1",
      "v2",
    ])
  })

  test("interleaves both stores by creation time", () => {
    const legacy = [message("l1", "user", 1), message("l2", "assistant", 5)]
    const v2 = [message("v1", "model-switched", 3), message("v2", "user", 7)]
    expect(mergeTranscripts(v2, legacy).map((entry: SessionMessageInfo) => entry.id)).toEqual(["l1", "v1", "l2", "v2"])
  })

  test("returns a single store untouched", () => {
    const only = [message("a", "user", 2), message("b", "assistant", 1)]
    expect(mergeTranscripts(only, [])).toBe(only)
    expect(mergeTranscripts([], only)).toBe(only)
  })
})

const info = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  sessionID: "ses",
  role,
  time: { created: 1 },
  ...extra,
})

const assistant = (data: SessionMessageInfo[]) =>
  data.find((entry) => entry.type === "assistant") as unknown as {
    content: Array<{ id: string; type?: string; text?: string; state?: { status?: string } }>
  }

describe("applying one event at a time", () => {
  test("a message arrives before its parts and keeps them afterwards", () => {
    let data = applyMessage([], info("m1", "assistant", { agent: "build" }))
    expect(data).toHaveLength(1)

    data = applyPart(data, { id: "p1", messageID: "m1", type: "text", text: "Hello" })
    expect(assistant(data).content).toEqual([{ type: "text", id: "p1", text: "Hello" }])

    // The engine updates the message again mid-turn; the parts it does not carry must survive.
    data = applyMessage(data, info("m1", "assistant", { agent: "build", cost: 0.01 }))
    expect(assistant(data).content).toEqual([{ type: "text", id: "p1", text: "Hello" }])
  })

  test("deltas append to the part that is streaming", () => {
    let data = applyMessage([], info("m1", "assistant"))
    data = applyPart(data, { id: "p1", messageID: "m1", type: "text", text: "Hel" })
    data = applyDelta(data, { messageID: "m1", partID: "p1", delta: "lo " })
    data = applyDelta(data, { messageID: "m1", partID: "p1", delta: "there" })
    expect(assistant(data).content[0]?.text).toBe("Hello there")
  })

  test("a delta for a part nobody announced is ignored rather than invented", () => {
    const data = applyMessage([], info("m1", "assistant"))
    expect(applyDelta(data, { messageID: "m1", partID: "ghost", delta: "x" })).toEqual(data)
  })

  test("a part that changes is replaced in place, not appended again", () => {
    let data = applyMessage([], info("m1", "assistant"))
    data = applyPart(data, {
      id: "t1",
      messageID: "m1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "ls" } },
    })
    data = applyPart(data, {
      id: "t1",
      messageID: "m1",
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "a.ts" },
    })
    expect(assistant(data).content).toHaveLength(1)
    expect(assistant(data).content[0]).toMatchObject({ state: { status: "completed" } })
  })

  test("a user message keeps the text and the attachments its parts carried", () => {
    const data = fromLegacy([
      {
        info: info("u1", "user"),
        parts: [
          { id: "p1", type: "text", text: "Look at this" },
          { id: "p2", type: "file", url: "data:image/png;base64,AAA", filename: "shot.png" },
        ],
      },
    ])
    expect(data[0]).toMatchObject({
      type: "user",
      text: "Look at this",
      files: [{ uri: "data:image/png;base64,AAA", name: "shot.png" }],
    })
  })

  test("removals take the message or the part out", () => {
    let data = applyMessage([], info("m1", "assistant"))
    data = applyPart(data, { id: "p1", messageID: "m1", type: "text", text: "Hello" })
    expect(assistant(removePart(data, { messageID: "m1", partID: "p1" })).content).toEqual([])
    expect(removeMessage(data, "m1")).toEqual([])
  })
})
