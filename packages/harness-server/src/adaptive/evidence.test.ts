import { describe, expect, test } from "bun:test"
import {
  EVIDENCE_SLICE_LIMIT,
  evidenceCandidates,
  evidenceHash,
  isEvidenceHash,
  sliceEvidence,
} from "./evidence"
import type { EpisodeEvent } from "./events"
import type { EpisodeSignal } from "./signals"

describe("evidence addresses (FH-006)", () => {
  test("the hash is sha256 in hex, and the golden vector holds", () => {
    const hash = evidenceHash("abc")
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hash).toHaveLength(64)

    // Same text, same address; a changed character is a different one.
    expect(evidenceHash("abc")).toBe(hash)
    expect(evidenceHash("abd")).not.toBe(hash)
  })

  test("only a 64-character lower-case hex string is an address of ours", () => {
    expect(isEvidenceHash(evidenceHash("abc"))).toBe(true)
    expect(isEvidenceHash("ABC")).toBe(false)
    expect(isEvidenceHash("a".repeat(63))).toBe(false)
    expect(isEvidenceHash("g".repeat(64))).toBe(false)
    expect(isEvidenceHash("")).toBe(false)
  })
})

describe("sliceEvidence (FH-006)", () => {
  test("a slice at the limit is kept whole and not marked", () => {
    const content = "x".repeat(EVIDENCE_SLICE_LIMIT)
    expect(sliceEvidence({ content })).toEqual({ content, truncated: false })
  })

  test("a slice one past the limit is cut, marked, and says how much it was", () => {
    const content = "x".repeat(EVIDENCE_SLICE_LIMIT + 1)
    const sliced = sliceEvidence({ content })
    expect(sliced.content).toHaveLength(EVIDENCE_SLICE_LIMIT)
    expect(sliced.truncated).toBe(true)
    expect(sliced.bytes).toBe(EVIDENCE_SLICE_LIMIT + 1)
  })

  test("an input that already said it was truncated stays marked without a cut", () => {
    expect(sliceEvidence({ content: "short", truncated: true })).toEqual({ content: "short", truncated: true })
  })

  test("bytes is the original text's UTF-8 size, not its character count", () => {
    const content = "é".repeat(EVIDENCE_SLICE_LIMIT + 1)
    const sliced = sliceEvidence({ content })
    expect(sliced.content).toHaveLength(EVIDENCE_SLICE_LIMIT)
    expect(sliced.truncated).toBe(true)
    expect(sliced.bytes).toBe(Buffer.byteLength(content, "utf8"))
    expect(sliced.bytes).toBeGreaterThan(content.length - 1)
  })
})

describe("evidenceCandidates (FH-006)", () => {
  const bash = (signal: Partial<EpisodeSignal>): EpisodeSignal => ({ tool: "bash", ok: true, paths: [], ...signal })

  test("a shell with output and a non-zero exit offers its output as a signal", () => {
    const candidates = evidenceCandidates([bash({ exit: 1, command: "bun test", out: "boom" })], [])
    expect(candidates).toEqual([{ content: "boom", kind: "signal", source: "bun test" }])
  })

  test("a clean exit is not evidence, whatever it printed", () => {
    expect(evidenceCandidates([bash({ exit: 0, command: "bun test", out: "looks bad" })], [])).toEqual([])
  })

  test("a shell with no exit is read, and one with no output is skipped", () => {
    expect(evidenceCandidates([bash({ command: "bun test", out: "boom" })], [])).toEqual([
      { content: "boom", kind: "signal", source: "bun test" },
    ])
    expect(evidenceCandidates([bash({ exit: 1, command: "bun test" })], [])).toEqual([])
  })

  test("only a shell's output is offered; an edit leaves files, not a slice", () => {
    const edit: EpisodeSignal = { tool: "edit", ok: true, paths: ["/work/proj/src/add.ts"] }
    expect(evidenceCandidates([edit], [])).toEqual([])
  })

  test("a signal the plugin already cut carries the mark to its slice", () => {
    const candidates = evidenceCandidates([bash({ exit: 1, command: "bun test", out: "boom", truncated: true })], [])
    expect(candidates).toEqual([{ content: "boom", kind: "signal", source: "bun test", truncated: true }])
  })

  test("an event that said something is a slice, sourced by what raised it", () => {
    const toolError: EpisodeEvent = {
      kind: "tool.error",
      seq: 1,
      at: 1,
      tool: "edit",
      message: "permission denied",
    }
    const sessionError: EpisodeEvent = { kind: "session.error", seq: 2, at: 2, error: "APIError", message: "rate limited" }
    expect(evidenceCandidates([], [toolError])).toEqual([
      { content: "permission denied", kind: "event", source: "tool:edit" },
    ])
    expect(evidenceCandidates([], [sessionError])).toEqual([
      { content: "rate limited", kind: "event", source: "session:APIError" },
    ])
  })

  test("an event with no message says nothing and is skipped", () => {
    const quiet: EpisodeEvent = { kind: "tool.error", seq: 1, at: 1, tool: "edit", message: "" }
    expect(evidenceCandidates([], [quiet])).toEqual([])
  })

  test("signals come before events, each in the order it was read", () => {
    const candidates = evidenceCandidates(
      [
        bash({ exit: 1, command: "first", out: "one" }),
        bash({ exit: 2, command: "second", out: "two" }),
      ],
      [
        { kind: "tool.error", seq: 1, at: 1, tool: "edit", message: "three" },
        { kind: "session.error", seq: 2, at: 2, error: "APIError", message: "four" },
      ],
    )
    expect(candidates.map((candidate) => candidate.content)).toEqual(["one", "two", "three", "four"])
  })
})
