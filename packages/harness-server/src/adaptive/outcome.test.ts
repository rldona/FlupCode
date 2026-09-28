import { describe, expect, test } from "bun:test"
import { OUTCOME_REF_LIMIT, deriveOutcome } from "./outcome"
import type { EpisodeOutcomeInput } from "./outcome"

const input = (overrides: Partial<EpisodeOutcomeInput> = {}): EpisodeOutcomeInput => ({
  verifications: [],
  failures: [],
  files: [],
  commands: [],
  ...overrides,
})

describe("outcome extraction (FH-005)", () => {
  test("a run that failed is failed, whatever its checks say", () => {
    const reading = deriveOutcome(
      input({ runStatus: "failed", verifications: [{ step: "check", ok: true }], files: ["src/a.ts"] }),
    )
    expect(reading).toEqual({ outcome: "failed", evidenceRefs: [] })
  })

  test("a run that stopped is partial, not failed", () => {
    expect(deriveOutcome(input({ runStatus: "stopped", failures: [{ summary: "x" }] }))).toEqual({
      outcome: "partial",
      evidenceRefs: [],
    })
  })

  test("a successful run whose last check is red is partial, citing only the red steps", () => {
    const reading = deriveOutcome(
      input({
        runStatus: "success",
        verifications: [
          { step: "lint", ok: true },
          { step: "test", ok: true },
          { step: "test", ok: false },
        ],
      }),
    )
    expect(reading).toEqual({ outcome: "partial", evidenceRefs: ["verify:test"] })
  })

  test("a successful run with every check green is success, one ref per distinct step", () => {
    const reading = deriveOutcome(
      input({
        runStatus: "success",
        verifications: [
          { step: "lint", ok: true },
          { step: "test", ok: true },
          { step: "lint", ok: true },
        ],
      }),
    )
    expect(reading).toEqual({ outcome: "success", evidenceRefs: ["verify:lint", "verify:test"] })
  })

  test("a successful run with no checks at all is success with no refs", () => {
    expect(deriveOutcome(input({ runStatus: "success", files: ["src/a.ts"] }))).toEqual({
      outcome: "success",
      evidenceRefs: [],
    })
  })

  test("a run still going says nothing yet", () => {
    expect(deriveOutcome(input({ runStatus: "running", verifications: [{ step: "test", ok: false }] }))).toEqual({
      outcome: "unknown",
      evidenceRefs: [],
    })
    expect(deriveOutcome(input({ runStatus: "awaiting", files: ["src/a.ts"] })).outcome).toBe("unknown")
  })

  test("with no run the checks decide: a red one is partial, an all-green one is success", () => {
    expect(deriveOutcome(input({ verifications: [{ step: "check", ok: false }] }))).toEqual({
      outcome: "partial",
      evidenceRefs: ["verify:check"],
    })
    expect(deriveOutcome(input({ verifications: [{ step: "check", ok: true }] }))).toEqual({
      outcome: "success",
      evidenceRefs: ["verify:check"],
    })
  })

  test("a failure fixed by a later green check reads as success with one ref", () => {
    const reading = deriveOutcome(
      input({
        verifications: [
          { step: "check", ok: false },
          { step: "check", ok: true },
        ],
      }),
    )
    expect(reading).toEqual({ outcome: "success", evidenceRefs: ["verify:check"] })
  })

  test("with no run and no checks, failures make it partial, one ref per anchor", () => {
    const reading = deriveOutcome(
      input({
        failures: [
          { summary: "one", file: "src/a.ts", line: 4 },
          { summary: "again", file: "src/a.ts", line: 4 },
          { summary: "unanchored" },
        ],
      }),
    )
    expect(reading).toEqual({
      outcome: "partial",
      evidenceRefs: ["failure:src/a.ts:4", "failure:unknown:0"],
    })
  })

  test("with no run, no checks and no failures, work done is still only partial", () => {
    expect(deriveOutcome(input({ files: ["src/a.ts"] }))).toEqual({ outcome: "partial", evidenceRefs: [] })
    expect(deriveOutcome(input({ commands: ["bun test"] }))).toEqual({ outcome: "partial", evidenceRefs: [] })
  })

  test("no evidence at all is unknown", () => {
    expect(deriveOutcome(input())).toEqual({ outcome: "unknown", evidenceRefs: [] })
  })

  test("refs are capped at the limit", () => {
    const steps = Array.from({ length: OUTCOME_REF_LIMIT + 5 }, (_, index) => ({ step: `s${index}`, ok: true }))
    const reading = deriveOutcome(input({ runStatus: "success", verifications: steps }))
    expect(reading.evidenceRefs).toHaveLength(OUTCOME_REF_LIMIT)
  })

  test("a failed run stays failed even when its last check is red or its failures are anchored", () => {
    const reading = deriveOutcome(
      input({
        runStatus: "failed",
        verifications: [{ step: "check", ok: false }],
        failures: [{ summary: "boom", file: "src/a.ts", line: 1 }],
      }),
    )
    expect(reading).toEqual({ outcome: "failed", evidenceRefs: [] })
  })

  test("a stopped run stays partial even when every check is green", () => {
    const reading = deriveOutcome(
      input({ runStatus: "stopped", verifications: [{ step: "check", ok: true }] }),
    )
    expect(reading).toEqual({ outcome: "partial", evidenceRefs: [] })
  })

  test("a run whose status is unknown and not terminal says nothing yet", () => {
    const reading = deriveOutcome(
      input({ runStatus: "queued", verifications: [{ step: "check", ok: false }], files: ["src/a.ts"] }),
    )
    expect(reading).toEqual({ outcome: "unknown", evidenceRefs: [] })
  })

  test("the last verdict of a repeated step decides, and a step fixed later drops out of the red refs", () => {
    const reading = deriveOutcome(
      input({
        verifications: [
          { step: "a", ok: false },
          { step: "b", ok: false },
          { step: "a", ok: true },
        ],
      }),
    )
    expect(reading).toEqual({ outcome: "partial", evidenceRefs: ["verify:b"] })
  })

  test("a successful run whose failed check was fixed later is success with one ref", () => {
    const reading = deriveOutcome(
      input({
        runStatus: "success",
        verifications: [
          { step: "check", ok: false },
          { step: "check", ok: true },
        ],
      }),
    )
    expect(reading).toEqual({ outcome: "success", evidenceRefs: ["verify:check"] })
  })

  test("with no run, a check outranks the failures whenever one ran", () => {
    const failures = [{ summary: "x", file: "src/a.ts", line: 1 }]
    expect(
      deriveOutcome(input({ verifications: [{ step: "check", ok: true }], failures })),
    ).toEqual({ outcome: "success", evidenceRefs: ["verify:check"] })
    expect(
      deriveOutcome(input({ verifications: [{ step: "check", ok: false }], failures })),
    ).toEqual({ outcome: "partial", evidenceRefs: ["verify:check"] })
  })

  test("red-step and failure refs are capped at the limit too", () => {
    const red = deriveOutcome(
      input({
        runStatus: "success",
        verifications: Array.from({ length: OUTCOME_REF_LIMIT + 5 }, (_, index) => ({ step: `s${index}`, ok: false })),
      }),
    )
    expect(red.outcome).toBe("partial")
    expect(red.evidenceRefs).toHaveLength(OUTCOME_REF_LIMIT)

    const failed = deriveOutcome(
      input({
        failures: Array.from({ length: OUTCOME_REF_LIMIT + 5 }, (_, index) => ({
          summary: `f${index}`,
          file: `src/f${index}.ts`,
        })),
      }),
    )
    expect(failed.outcome).toBe("partial")
    expect(failed.evidenceRefs).toHaveLength(OUTCOME_REF_LIMIT)
  })

  test("the same evidence always reads the same", () => {
    const sample = input({
      runStatus: "success",
      verifications: [
        { step: "lint", ok: true },
        { step: "test", ok: false },
      ],
      failures: [{ summary: "x", file: "src/a.ts", line: 1 }],
      files: ["src/a.ts"],
      commands: ["bun test"],
    })
    expect(deriveOutcome(sample)).toEqual(deriveOutcome(sample))
  })
})
