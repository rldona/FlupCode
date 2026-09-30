import { describe, expect, test } from "bun:test"
import type { ContextItem, ContextItemKind } from "./decision"
import { DROPPABLE_CONTEXT_KINDS } from "./decision"
import {
  archiveContextItems,
  compactionPlanFrom,
  planID,
  recoverableIDs,
  recoverContextItems,
} from "./compaction-plan"
import { planContextItems, scoreContextItems } from "./scoring"
import type { ContextScore } from "./scoring"
import { DEFAULT_CONTEXT_BUDGET } from "./config"

const NOW = 1_700_000_000_000

const item = (overrides: Partial<ContextItem> & { id: string; kind: ContextItemKind }): ContextItem => ({
  tokens: 10,
  referenced: false,
  anchors: 0,
  archived: false,
  ...overrides,
})

const score = (overrides: Partial<ContextScore> & { id: string; kind: ContextItemKind }): ContextScore => ({
  score: 0.5,
  disposition: "archive",
  reason: "ambiguous",
  protected: false,
  tokens: 10,
  ...overrides,
})

describe("compactionPlanFrom (FH-022)", () => {
  test("buckets entries by disposition and keeps each entry's reason", () => {
    const plan = compactionPlanFrom({
      id: planID("run:task"),
      scores: [
        score({ id: "k", kind: "objective", disposition: "keep", reason: "protected", protected: true }),
        score({ id: "a", kind: "file", disposition: "archive", reason: "ambiguous" }),
        score({ id: "d", kind: "tool", disposition: "drop", reason: "low-value-payload" }),
      ],
      createdAt: NOW,
    })
    expect(plan.id).toBe("plan:run:task")
    expect(plan.keep.map((entry) => entry.id)).toEqual(["k"])
    expect(plan.archive.map((entry) => entry.id)).toEqual(["a"])
    expect(plan.drop.map((entry) => entry.id)).toEqual(["d"])
    expect(plan.archive[0]!.reason).toBe("ambiguous")
    expect(plan.drop[0]!.reason).toBe("low-value-payload")
    expect(plan.scoreSource).toBe("baseline")
    expect(plan.degraded).toBe(false)
  })

  test("carries the evidence ref of each entry when the source has one", () => {
    const plan = compactionPlanFrom({
      id: planID("episode:1"),
      scores: [score({ id: "a", kind: "error", disposition: "keep", protected: true })],
      evidenceFor: (id) => (id === "a" ? "hash:abc" : undefined),
      createdAt: NOW,
    })
    expect(plan.keep[0]!.evidenceRef).toBe("hash:abc")
  })

  test("only low-value payloads can be dropped", () => {
    const plan = compactionPlanFrom({
      id: planID("run:task"),
      scores: [
        score({ id: "d1", kind: "tool", disposition: "drop" }),
        score({ id: "d2", kind: "message", disposition: "drop" }),
      ],
      createdAt: NOW,
    })
    expect(plan.drop.every((entry) => DROPPABLE_CONTEXT_KINDS.includes(entry.kind))).toBe(true)
  })
})

describe("recovery (FH-022)", () => {
  const planWithArchive = compactionPlanFrom({
    id: planID("run:task"),
    scores: [
      score({ id: "k", kind: "objective", disposition: "keep", protected: true }),
      score({ id: "a", kind: "file", disposition: "archive", reason: "ambiguous" }),
    ],
    createdAt: NOW,
  })

  test("lists the archived ids and marks exactly those items archived", () => {
    expect(recoverableIDs(planWithArchive)).toEqual(["a"])
    const items = [item({ id: "k", kind: "objective", referenced: true }), item({ id: "a", kind: "file" })]
    const archived = archiveContextItems(items, planWithArchive)
    expect(archived.find((entry) => entry.id === "a")!.archived).toBe(true)
    expect(archived.find((entry) => entry.id === "k")!.archived).toBe(false)
  })

  test("recovery clears the archived mark for the next plan, not the prompt in flight", () => {
    const items = [item({ id: "a", kind: "file", archived: true })]
    expect(recoverContextItems(items, ["a"])[0]!.archived).toBe(false)
  })

  test("an archived, referenced item is re-admitted by the next plan", () => {
    const items: ContextItem[] = [item({ id: "a", kind: "file", referenced: true, archived: true })]
    const planned = planContextItems({
      items,
      budget: DEFAULT_CONTEXT_BUDGET,
      now: NOW,
    })
    expect(planned[0]!.disposition).toBe("keep")
    // And a merely archived item with no reference stays out.
    const unreferenced = planContextItems({
      items: [item({ id: "b", kind: "file", archived: true })],
      budget: DEFAULT_CONTEXT_BUDGET,
      now: NOW,
    })
    expect(unreferenced[0]!.disposition).toBe("archive")
  })

  test("the scored archive is reversible: the plan points at the item, not at its bytes", () => {
    const entry = scoreContextItems({
      items: [item({ id: "a", kind: "file" })],
      now: NOW,
    })[0]!
    expect(entry.disposition).toBe("archive")
    expect(recoverableIDs(compactionPlanFrom({ id: planID("x"), scores: [entry], createdAt: NOW }))).toEqual(["a"])
  })
})
