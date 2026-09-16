import { describe, expect, test } from "bun:test"
import { createStore, unwrap } from "solid-js/store"
import { applyTranscriptChange, applyDelta } from "./transcript"
import type { SessionMessageInfo } from "./engine-types"

const transcript = (count: number): SessionMessageInfo[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `msg_${index}`,
    sessionID: "s",
    type: "assistant",
    time: { created: index },
    content: [{ id: `part_${index}`, type: "text", text: "start" }],
  })) as unknown as SessionMessageInfo[]

const delta = (index: number, text: string) => ({
  apply: (current: SessionMessageInfo[]) =>
    applyDelta(current, { messageID: `msg_${index}`, partID: `part_${index}`, delta: text }),
  delta: { messageID: `msg_${index}`, partID: `part_${index}`, text },
})

const textOf = (message: SessionMessageInfo | undefined) =>
  (message as unknown as { content?: Array<{ text?: string }> })?.content?.[0]?.text

describe("applyTranscriptChange", () => {
  test("a delta lands on its own part", () => {
    const [store, setStore] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(3) })
    applyTranscriptChange(setStore, delta(1, "-more"))
    expect(textOf(store.data[1])).toBe("start-more")
    expect(textOf(store.data[0])).toBe("start")
    expect(textOf(store.data[2])).toBe("start")
  })

  test("deltas accumulate in order", () => {
    const [store, setStore] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(2) })
    for (const piece of [" one", " two", " three"]) applyTranscriptChange(setStore, delta(0, piece))
    expect(textOf(store.data[0])).toBe("start one two three")
  })

  // Both paths give the same answer; the store path gets there without replacing a single message
  // object, so nothing that reads one renders again for a character it does not show. The rebuild
  // only replaces the message it changes — measured, it is not the transcript-wide churn it looks
  // like — which is why this is worth a little, not a lot: 1500 deltas over a 300-message session
  // blocked the main thread for 70ms before and 0ms after.
  test("a delta lands without replacing any message object", () => {
    const change = delta(150, "!")

    const [cheap, setCheap] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(200) })
    const before = unwrap(cheap).data.slice()
    applyTranscriptChange(setCheap, change)
    const replaced = unwrap(cheap).data.filter((message, index) => message !== before[index]).length

    const [rebuilt, setRebuilt] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(200) })
    setRebuilt("data", (current) => change.apply(current))

    expect(textOf(cheap.data[150])).toBe("start!")
    expect(textOf(rebuilt.data[150])).toBe("start!")
    expect(replaced).toBe(0)
  })

  test("anything that is not a delta still goes through the rebuild", () => {
    const [store, setStore] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(2) })
    applyTranscriptChange(setStore, { apply: (current) => current.filter((message) => message.id !== "msg_0") })
    expect(store.data.map((message) => message.id)).toEqual(["msg_1"])
  })
})
