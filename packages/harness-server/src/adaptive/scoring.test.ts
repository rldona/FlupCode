import { describe, expect, test } from "bun:test"
import type { ContextItem, ContextItemKind } from "./decision"
import { DROPPABLE_CONTEXT_KINDS, PROTECTED_CONTEXT_KINDS } from "./decision"
import {
  DROP_THRESHOLD,
  KEEP_THRESHOLD,
  RECENCY_WINDOW_MS,
  deterministicContextItem,
  isAmbiguous,
  planContextItems,
  scoreContextItems,
} from "./scoring"
import type { ContextBudget } from "./scoring"
import { DEFAULT_CONTEXT_BUDGET } from "./config"

const NOW = 1_700_000_000_000

const item = (overrides: Partial<ContextItem> & { id: string; kind: ContextItemKind }): ContextItem => ({
  tokens: 10,
  referenced: false,
  anchors: 0,
  archived: false,
  ...overrides,
})

const scoreOf = (items: ContextItem[], id: string) => {
  const entry = scoreContextItems({ items, now: NOW }).find((entry) => entry.id === id)
  if (!entry) throw new Error(`no entry for ${id}`)
  return entry
}

describe("scoreContextItems (FH-021)", () => {
  test("golden scores follow the documented formula", () => {
    const items: ContextItem[] = [
      item({ id: "obj", kind: "objective", referenced: true }),
      item({ id: "err", kind: "error", referenced: true }),
      item({ id: "file-ref", kind: "file", referenced: true, anchors: 1 }),
      item({ id: "cmd-ref", kind: "command", referenced: true }),
      item({ id: "file", kind: "file" }),
      item({ id: "tool", kind: "tool" }),
      item({ id: "msg", kind: "message" }),
      item({ id: "old", kind: "file", referenced: true, createdAt: NOW - 2 * RECENCY_WINDOW_MS }),
    ]
    expect(scoreOf(items, "obj").score).toBeCloseTo(0.85, 6)
    expect(scoreOf(items, "err").score).toBeCloseTo(0.85, 6)
    expect(scoreOf(items, "file-ref").score).toBeCloseTo(0.7525, 6)
    expect(scoreOf(items, "cmd-ref").score).toBeCloseTo(0.67, 6)
    expect(scoreOf(items, "file").score).toBeCloseTo(0.515, 6)
    expect(scoreOf(items, "tool").score).toBeCloseTo(0.245, 6)
    expect(scoreOf(items, "msg").score).toBeCloseTo(0.2225, 6)
    expect(scoreOf(items, "old").score).toBeCloseTo(0.515, 6)
  })

  test("reason explains the dominant keep signal", () => {
    expect(scoreOf([item({ id: "ref", kind: "file", referenced: true })], "ref").reason).toBe("class-weight")
  })

  test("objective and errors are never below the drop threshold", () => {
    const items: ContextItem[] = [
      item({ id: "obj", kind: "objective", createdAt: NOW - 3 * RECENCY_WINDOW_MS }),
      item({ id: "err", kind: "error", createdAt: NOW - 3 * RECENCY_WINDOW_MS }),
      item({ id: "other", kind: "other", createdAt: NOW - 3 * RECENCY_WINDOW_MS }),
    ]
    for (const entry of scoreContextItems({ items, now: NOW })) {
      expect(PROTECTED_CONTEXT_KINDS).toContain(entry.kind)
      expect(entry.disposition).toBe("keep")
      expect(entry.score).toBeGreaterThan(DROP_THRESHOLD)
    }
  })

  test("a project memory note is protected like the objective", () => {
    // A human directive must never leave the prompt on a low score; only the objective, errors,
    // unknown items and memory are protected this way.
    const entry = scoreOf([item({ id: "m", kind: "memory", createdAt: NOW - 3 * RECENCY_WINDOW_MS })], "m")
    expect(PROTECTED_CONTEXT_KINDS).toContain("memory")
    expect(entry.protected).toBe(true)
    expect(entry.disposition).toBe("keep")
    expect(entry.reason).toBe("protected")
  })

  test("drop only touches low-value payloads; other low scores archive", () => {
    const items: ContextItem[] = [
      item({ id: "tool", kind: "tool" }),
      item({ id: "msg", kind: "message" }),
      item({ id: "file", kind: "file" }),
      item({ id: "cmd", kind: "command" }),
    ]
    const entries = scoreContextItems({ items, now: NOW })
    for (const entry of entries.filter((entry) => entry.disposition === "drop")) {
      expect(DROPPABLE_CONTEXT_KINDS).toContain(entry.kind)
    }
    expect(entries.find((entry) => entry.id === "file")!.disposition).toBe("archive")
    expect(entries.find((entry) => entry.id === "cmd")!.disposition).toBe("archive")
  })

  test("an archived but referenced item recovers above the keep threshold", () => {
    const [archived] = scoreContextItems({
      items: [item({ id: "f", kind: "file", referenced: true, archived: true })],
      now: NOW,
    })
    expect(archived!.score).toBeCloseTo(0.815, 6)
    expect(archived!.disposition).toBe("keep")
  })

  test("the ambiguity band is exactly the non-protected (drop, keep) interval", () => {
    const file = scoreOf([item({ id: "f", kind: "file" })], "f")
    const obj = scoreOf([item({ id: "o", kind: "objective", referenced: true })], "o")
    const tool = scoreOf([item({ id: "t", kind: "tool" })], "t")
    expect(file.disposition).toBe("archive")
    expect(isAmbiguous(file)).toBe(true)
    expect(isAmbiguous(obj)).toBe(false) // protected
    expect(isAmbiguous(tool)).toBe(false) // below the drop threshold
  })

  test("is deterministic: the same input scores the same", () => {
    const items = [item({ id: "f", kind: "file", referenced: true, anchors: 2 })]
    expect(scoreContextItems({ items, now: NOW })).toEqual(scoreContextItems({ items, now: NOW }))
  })
})

describe("planContextItems (FH-021)", () => {
  type BudgetOverride = Partial<Omit<ContextBudget, "perClass">> & {
    perClass?: Partial<Record<ContextItemKind, number>>
  }
  const budget = (overrides: BudgetOverride = {}): ContextBudget => ({
    ...DEFAULT_CONTEXT_BUDGET,
    ...overrides,
    perClass: { ...DEFAULT_CONTEXT_BUDGET.perClass, ...overrides.perClass },
  })

  test("keeps the input order and never reorders", () => {
    const items = [
      item({ id: "a", kind: "artifact" }),
      item({ id: "f", kind: "file", referenced: true }),
      item({ id: "o", kind: "objective", referenced: true }),
    ]
    const planned = planContextItems({ items, budget: budget(), now: NOW })
    expect(planned.map((entry) => entry.id)).toEqual(["a", "f", "o"])
  })

  test("a keep that does not fit the class budget is archived, never dropped", () => {
    const items = [
      item({ id: "o", kind: "objective", referenced: true, tokens: 100 }),
      item({ id: "f1", kind: "file", referenced: true, tokens: 100 }),
      item({ id: "f2", kind: "file", referenced: true, tokens: 100 }),
    ]
    const planned = planContextItems({
      items,
      budget: budget({ total: 250, perClass: { file: 150 } }),
      now: NOW,
    })
    const byID = Object.fromEntries(planned.map((entry) => [entry.id, entry]))
    expect(byID.o!.disposition).toBe("keep")
    expect(byID.f1!.disposition).toBe("keep")
    expect(byID.f2!.disposition).toBe("archive")
    expect(byID.f2!.reason).toBe("budget-overflow")
  })

  test("the global total bounds evidence after the protected items took their share", () => {
    const items = [
      item({ id: "o", kind: "objective", referenced: true, tokens: 200 }),
      item({ id: "f", kind: "file", referenced: true, tokens: 100 }),
    ]
    const planned = planContextItems({
      items,
      budget: budget({ total: 250 }),
      now: NOW,
    })
    const byID = Object.fromEntries(planned.map((entry) => [entry.id, entry]))
    expect(byID.o!.disposition).toBe("keep")
    expect(byID.f!.disposition).toBe("archive")
    expect(byID.f!.reason).toBe("budget-overflow")
  })

  test("fills by class order, not by score, when the global total has room for only one", () => {
    // The file scores higher than the handoff, but the handoff's class comes first (objective ->
    // evidence), so it wins the single free slot and the file is archived.
    const items = [
      item({ id: "f", kind: "file", referenced: true, anchors: 4, tokens: 10 }),
      item({ id: "h", kind: "handoff", referenced: true, anchors: 1, tokens: 10 }),
    ]
    const planned = planContextItems({
      items,
      budget: budget({ total: 10, perClass: { file: 1_000, handoff: 1_000 } }),
      now: NOW,
    })
    const byID = Object.fromEntries(planned.map((entry) => [entry.id, entry]))
    expect(byID.f!.score).toBeGreaterThan(byID.h!.score)
    expect(byID.h!.disposition).toBe("keep")
    expect(byID.f!.disposition).toBe("archive")
    expect(byID.f!.reason).toBe("budget-overflow")
  })

  test("drops do not consume budget", () => {
    const items = [
      item({ id: "t", kind: "tool", tokens: 2_000 }),
      item({ id: "f", kind: "file", referenced: true, tokens: 9_000 }),
    ]
    const planned = planContextItems({
      items,
      budget: budget({ total: 10_000, perClass: { file: 10_000 } }),
      now: NOW,
    })
    const byID = Object.fromEntries(planned.map((entry) => [entry.id, entry]))
    expect(byID.t!.disposition).toBe("drop")
    expect(byID.f!.disposition).toBe("keep")
  })
})

describe("deterministicContextItem (FH-021)", () => {
  test("is the scorer and nothing else: referenced keeps, low-value payload drops", () => {
    const answer = deterministicContextItem(
      {
        objective: "fix the bug",
        items: [
          item({ id: "o", kind: "objective", referenced: true }),
          item({ id: "t", kind: "tool" }),
        ],
      },
      NOW,
    )
    expect(answer.decisions).toEqual([
      { id: "o", disposition: "keep" },
      { id: "t", disposition: "drop" },
    ])
    expect(KEEP_THRESHOLD).toBeGreaterThan(DROP_THRESHOLD)
  })
})
