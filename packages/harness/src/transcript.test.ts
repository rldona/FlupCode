import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "./engine-types"
import { applyDelta } from "./transcript"

const streaming = () =>
  [
    { id: "m1", type: "assistant", time: { created: 1 }, content: [{ type: "text", id: "p1", text: "Hel" }] },
  ] as unknown as SessionMessageInfo[]

const text = (data: SessionMessageInfo[]) =>
  (data[0] as unknown as { content: Array<{ text?: string }> }).content[0]?.text

describe("applyDelta", () => {
  test("deltas append to the part that is streaming", () => {
    const data = applyDelta(applyDelta(streaming(), { messageID: "m1", partID: "p1", delta: "lo " }), {
      messageID: "m1",
      partID: "p1",
      delta: "there",
    })
    expect(text(data)).toBe("Hello there")
  })

  test("a delta for a part nobody announced is ignored rather than invented", () => {
    const data = streaming()
    expect(applyDelta(data, { messageID: "m1", partID: "ghost", delta: "x" })).toEqual(data)
  })
})
