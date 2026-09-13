import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "./engine-types"
import { mergeTranscripts } from "./client"

const message = (id: string, type: string, created: number) =>
  ({ id, type, time: { created } }) as unknown as SessionMessageInfo

describe("mergeTranscripts", () => {
  test("keeps the legacy history when a session continues in v2", () => {
    const legacy = [message("l1", "user", 1), message("l2", "assistant", 2), message("l3", "user", 3)]
    const v2 = [message("v1", "user", 10), message("v2", "assistant", 11)]
    expect(mergeTranscripts(v2, legacy).map((entry) => entry.id)).toEqual(["l1", "l2", "l3", "v1", "v2"])
  })

  test("interleaves both stores by creation time", () => {
    const legacy = [message("l1", "user", 1), message("l2", "assistant", 5)]
    const v2 = [message("v1", "model-switched", 3), message("v2", "user", 7)]
    expect(mergeTranscripts(v2, legacy).map((entry) => entry.id)).toEqual(["l1", "v1", "l2", "v2"])
  })

  test("returns a single store untouched", () => {
    const only = [message("a", "user", 2), message("b", "assistant", 1)]
    expect(mergeTranscripts(only, [])).toBe(only)
    expect(mergeTranscripts([], only)).toBe(only)
  })
})
