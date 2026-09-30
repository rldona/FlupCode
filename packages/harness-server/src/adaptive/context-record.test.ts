/**
 * The audit row of a plan: encoding, bounding and defensive decoding (FH-022).
 *
 * A plan row is read by an audit and must never take a reader down: a hand-edited or older row reads
 * as empty or unknown rather than as a guess. The encoder is the mirror of the decision record, and
 * the bound is what keeps a huge plan from turning `items_json` into a transcript.
 */

import { describe, expect, test } from "bun:test"
import type { ContextPlanEntry, StoredPlanInput } from "../types"
import {
  PLAN_ITEM_LIMIT,
  PLAN_ITEMS_CHAR_LIMIT,
  boundPlanEntries,
  objectiveHash,
  planFromRow,
  planRowFrom,
} from "./context-record"
import type { PlanRow } from "./context-record"
import { planID } from "./compaction-plan"

const entry = (overrides: Partial<ContextPlanEntry> & { id: string }): ContextPlanEntry => ({
  kind: "file",
  score: 0.5,
  disposition: "archive",
  reason: "ambiguous",
  protected: false,
  tokens: 10,
  ...overrides,
})

const input = (overrides: Partial<StoredPlanInput> = {}): StoredPlanInput => ({
  id: planID("run-1:task-1"),
  runID: "run-1",
  taskID: "task-1",
  objectiveHash: objectiveHash("fix the bug"),
  entries: [
    entry({ id: "objective", kind: "objective", disposition: "keep", reason: "protected", protected: true, score: 0.85 }),
    entry({ id: "tool:abc", kind: "tool", disposition: "drop", reason: "low-value-payload", score: 0.1, tokens: 5 }),
    entry({ id: "file:def", kind: "file", disposition: "keep", reason: "class-weight", score: 0.75 }),
  ],
  scoreSource: "baseline",
  degraded: false,
  applied: false,
  tokensBefore: 25,
  tokensAfter: 15,
  ...overrides,
})

describe("planID and objectiveHash (FH-022)", () => {
  test("the plan id mirrors decisionID and the objective is a hash, never the text", () => {
    expect(planID("run-1:task-1")).toBe("plan:run-1:task-1")
    expect(objectiveHash("fix the bug")).toMatch(/^[0-9a-f]{64}$/)
    expect(objectiveHash("fix the bug")).not.toContain("fix the bug")
    expect(objectiveHash("fix the bug")).toBe(objectiveHash("fix the bug"))
    expect(objectiveHash("fix the bug")).not.toBe(objectiveHash("fix the other bug"))
  })
})

describe("boundPlanEntries (FH-022)", () => {
  test("keeps every entry while the plan fits by count and by characters", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })]
    expect(boundPlanEntries(entries)).toEqual(entries)
  })

  test("trims the tail past the item limit", () => {
    const entries = Array.from({ length: PLAN_ITEM_LIMIT + 3 }, (_, index) => entry({ id: `item:${index}` }))
    // The character limit is lifted so this asserts the count bound on its own.
    const bounded = boundPlanEntries(entries, PLAN_ITEM_LIMIT, Number.MAX_SAFE_INTEGER)
    expect(bounded).toHaveLength(PLAN_ITEM_LIMIT)
    expect(bounded[0]!.id).toBe("item:0")
    expect(bounded.at(-1)!.id).toBe(`item:${PLAN_ITEM_LIMIT - 1}`)
  })

  test("trims the tail past the character limit too, and the bytes stay in their source", () => {
    // Each entry serializes to well over 100 characters; a small character limit keeps as many
    // whole entries as fit and drops the rest from the tail rather than cutting one string.
    const entries = Array.from({ length: 20 }, (_, index) => entry({ id: `file:${index}` }))
    const bounded = boundPlanEntries(entries, PLAN_ITEM_LIMIT, 500)
    expect(bounded.length).toBeGreaterThan(0)
    expect(bounded.length).toBeLessThan(entries.length)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(500)
    expect(bounded[0]!.id).toBe("file:0")
  })
})

describe("planRowFrom / planFromRow (FH-022)", () => {
  test("counts each disposition and round-trips a plan through the row", () => {
    const row = planRowFrom(input(), 1_000)
    expect(row.id).toBe("plan:run-1:task-1")
    expect(row.item_count).toBe(3)
    expect(row.keep_count).toBe(2)
    expect(row.archive_count).toBe(0)
    expect(row.drop_count).toBe(1)
    expect(row.truncated).toBe(0)
    expect(row.objective_hash).toMatch(/^[0-9a-f]{64}$/)

    const decoded = planFromRow(row)!
    expect(decoded).toMatchObject({
      id: "plan:run-1:task-1",
      runID: "run-1",
      taskID: "task-1",
      scoreSource: "baseline",
      degraded: false,
      applied: false,
      truncated: false,
      tokensBefore: 25,
      tokensAfter: 15,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    expect(decoded.entries).toEqual(input().entries)
  })

  test("marks a plan that had to be trimmed rather than storing it whole", () => {
    // Over the character limit: `planRowFrom` bounds with the production limits, so a few oversized
    // entries are stored and the rest are trimmed from the tail.
    const entries = Array.from({ length: 8 }, (_, index) =>
      entry({ id: `file:${index}`, evidenceRef: "x".repeat(5_000) }),
    )
    const decoded = planFromRow(planRowFrom(input({ entries }), 1_000))!
    expect(decoded.truncated).toBe(true)
    expect(decoded.entries.length).toBeGreaterThan(0)
    expect(decoded.entries.length).toBeLessThan(entries.length)
    expect(JSON.stringify(decoded.entries).length).toBeLessThanOrEqual(PLAN_ITEMS_CHAR_LIMIT)
  })

  test("stores absent scope and reason columns as null and reads them as absent", () => {
    const row = planRowFrom(
      input({ runID: undefined, taskID: undefined, episodeID: "episode:1", applied: true, degraded: true, degradedReason: "timeout" }),
      1_000,
    )
    expect(row.run_id).toBeNull()
    expect(row.task_id).toBeNull()
    const decoded = planFromRow(row)!
    expect(decoded.runID).toBeUndefined()
    expect(decoded.taskID).toBeUndefined()
    expect(decoded.episodeID).toBe("episode:1")
    expect(decoded.degraded).toBe(true)
    expect(decoded.degradedReason).toBe("timeout")
    expect(decoded.applied).toBe(true)
  })

  test("an unknown score source keeps the plan and exposes the raw value (AH-C02)", () => {
    const row = planRowFrom(input(), 1_000)
    const plan = planFromRow({ ...row, score_source: "mystery" })
    expect(plan).toMatchObject({ id: row.id, scoreSource: "unknown", rawScoreSource: "mystery" })
    expect(plan.entries).toHaveLength(row.item_count)
  })

  test("the v1 score sources read as the v2 ones, the way the migration maps them (AH-C02)", () => {
    const row = planRowFrom(input(), 1_000)
    expect(planFromRow({ ...row, score_source: "jev", score_provider: null })).toMatchObject({
      scoreSource: "model",
      scoreProvider: "jev",
    })
    const baseline = planFromRow({ ...row, score_source: "deterministic" })
    expect(baseline.scoreSource).toBe("baseline")
    expect(baseline.rawScoreSource).toBeUndefined()
  })

  test("a model-refined plan round-trips the model that refined it", () => {
    const plan = planFromRow(planRowFrom(input({ scoreSource: "model", scoreProvider: "small-llm" }), 1_000))
    expect(plan).toMatchObject({ scoreSource: "model", scoreProvider: "small-llm" })
  })

  test("a corrupt or non-array items_json reads as empty entries", () => {
    const row = planRowFrom(input(), 1_000)
    expect(planFromRow({ ...row, items_json: "{not json" })!.entries).toEqual([])
    expect(planFromRow({ ...row, items_json: "42" })!.entries).toEqual([])
    expect(planFromRow({ ...row, items_json: "{}" })!.entries).toEqual([])
  })

  test("an entry with an unknown kind or disposition is dropped, the valid ones kept", () => {
    const row = planRowFrom(input(), 1_000)
    const items = JSON.stringify([
      { id: "good", kind: "file", score: 0.5, disposition: "keep", reason: "class-weight", protected: false, tokens: 10 },
      { id: "bad-kind", kind: "mystery", score: 0.5, disposition: "keep", reason: "class-weight", protected: false, tokens: 10 },
      { id: "bad-disposition", kind: "file", score: 0.5, disposition: "explode", reason: "class-weight", protected: false, tokens: 10 },
    ])
    const decoded = planFromRow({ ...row, items_json: items })!
    expect(decoded.entries.map((decoded) => decoded.id)).toEqual(["good"])
  })

  test("a malformed entry field falls back to a safe value, never to a guess", () => {
    const row = planRowFrom(input(), 1_000)
    const items = JSON.stringify([
      { id: 7, kind: "file", score: "high", disposition: "archive", reason: 3, protected: "yes", tokens: null },
    ])
    const [decoded] = planFromRow({ ...row, items_json: items })!.entries
    expect(decoded).toEqual({ id: "", kind: "file", score: 0, disposition: "archive", reason: "", protected: false, tokens: 0 })
  })

  test("an unknown degraded reason is left undefined while degraded stays true", () => {
    const row = planRowFrom(input({ degraded: true, degradedReason: "timeout" }), 1_000)
    const decoded = planFromRow({ ...row, degraded_reason: "not-a-reason" })!
    expect(decoded.degraded).toBe(true)
    expect(decoded.degradedReason).toBeUndefined()
  })

  test("a hand-written row with no truncated column reads as untruncated", () => {
    const row = planRowFrom(input(), 1_000)
    const decoded = planFromRow({ ...row, truncated: 0 } as PlanRow)!
    expect(decoded.truncated).toBe(false)
  })
})
