import { describe, expect, test } from "bun:test"
import { describeReplayEvent, replayCounts, replaySeq, replayTime } from "./replay"

describe("reading a session's events back (H-33)", () => {
  test("names the event, and the tool or model it is about", () => {
    expect(describeReplayEvent({ type: "session.next.step.started", data: { timestamp: 1 } })).toEqual({
      label: "Step started",
    })
    expect(
      describeReplayEvent({ type: "session.next.tool.called", data: { tool: "bash", callID: "c1" } }),
    ).toEqual({ label: "Called a tool", detail: "bash" })
    // An event the engine adds later is still shown, rather than dropped for being unknown.
    expect(describeReplayEvent({ type: "session.next.future.thing" })).toEqual({ label: "Event" })
    expect(describeReplayEvent({})).toEqual({ label: "Event" })
  })

  test("the sequence is what a replay continues from, and only when it is there", () => {
    expect(replaySeq({ durable: { seq: 12 } })).toBe(12)
    expect(replaySeq({})).toBeUndefined()
    expect(replaySeq({ durable: {} })).toBeUndefined()
  })

  test("a timestamp is read only when it is a number", () => {
    expect(replayTime({ data: { timestamp: 1000 } })).toBe(1000)
    expect(replayTime({ data: { timestamp: "1000" } })).toBeUndefined()
    expect(replayTime({})).toBeUndefined()
  })

  test("the summary counts what is in the replay, most frequent first", () => {
    const counts = replayCounts([
      { type: "session.next.step.started" },
      { type: "session.next.step.started" },
      { type: "session.next.tool.called", data: { tool: "bash" } },
    ])
    expect(counts).toEqual([
      { label: "Step started", count: 2 },
      { label: "Called a tool", count: 1 },
    ])
  })
})
