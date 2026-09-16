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

  // The point of the whole thing: a turn is thousands of deltas, and rebuilding the transcript for
  // each one allocates a new object for every message it walks past, which is what made the cost of
  // a single character grow with the length of the session. Both paths are run over the same
  // transcript here, and counted.
  test("a delta rewrites one part where a rebuild rewrites the whole transcript", () => {
    const change = delta(150, "!")

    const [cheap, setCheap] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(200) })
    const beforeCheap = unwrap(cheap).data.slice()
    applyTranscriptChange(setCheap, change)
    const replacedByPath = unwrap(cheap).data.filter((message, index) => message !== beforeCheap[index]).length

    const [rebuilt, setRebuilt] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(200) })
    const beforeRebuild = unwrap(rebuilt).data.slice()
    setRebuilt("data", (current) => change.apply(current))
    const replacedByRebuild = unwrap(rebuilt).data.filter((message, index) => message !== beforeRebuild[index]).length

    // Same answer, and the store path touches nothing it does not have to.
    expect(textOf(cheap.data[150])).toBe("start!")
    expect(textOf(rebuilt.data[150])).toBe("start!")
    expect(replacedByPath).toBe(0)
    expect(replacedByRebuild).toBeGreaterThan(100)
  })

  test("anything that is not a delta still goes through the rebuild", () => {
    const [store, setStore] = createStore<{ data: SessionMessageInfo[] }>({ data: transcript(2) })
    applyTranscriptChange(setStore, { apply: (current) => current.filter((message) => message.id !== "msg_0") })
    expect(store.data.map((message) => message.id)).toEqual(["msg_1"])
  })
})
