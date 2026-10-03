import { describe, expect, test } from "bun:test"
import { DEFAULT_DECISION_POLICY } from "./decision"
import { decisionFromRow, decisionRowFrom } from "./decision-record"
import type { StoredDecisionInput } from "../types"

const input = (overrides: Partial<StoredDecisionInput> = {}): StoredDecisionInput => ({
  id: "completion:episode:run:1",
  kind: "completion",
  inputsHash: "a".repeat(64),
  stateSummary: { kind: "completion" },
  answer: { verdict: "complete" },
  baselineAnswer: { verdict: "complete" },
  baselineRule: "episode-outcome",
  provider: "small-llm",
  attemptedProvider: "small-llm",
  modelVersion: "small-1",
  source: "model",
  providerID: "small-llm",
  providerVersion: "small-1",
  costUsd: 0.002,
  inputTokens: 640,
  degraded: false,
  latencyMs: 30,
  policy: DEFAULT_DECISION_POLICY,
  shadow: true,
  ...overrides,
})

describe("the decision row round trip (AH-C02)", () => {
  test("provider id, version, cost and tokens survive a round trip", () => {
    expect(decisionFromRow(decisionRowFrom(input(), 1_000))).toMatchObject({
      source: "model",
      providerID: "small-llm",
      providerVersion: "small-1",
      costUsd: 0.002,
      inputTokens: 640,
    })
  })

  test("a row is written without a label; the label has its own writer", () => {
    const row = decisionRowFrom(input(), 1_000)
    expect(row.label).toBeNull()
    expect(row.labeled_at).toBeNull()
    expect(decisionFromRow(row).label).toBeUndefined()
  })

  test("a zero cost is a measured cost, not a missing one", () => {
    expect(decisionFromRow(decisionRowFrom(input({ costUsd: 0, inputTokens: 0 }), 1_000))).toMatchObject({
      costUsd: 0,
      inputTokens: 0,
    })
  })
})

describe("a reader that tolerates what it does not know (AH-C02)", () => {
  const row = decisionRowFrom(input(), 1_000)

  test("an unknown source keeps the row and exposes the raw value", () => {
    const decision = decisionFromRow({ ...row, source: "ensemble" })
    expect(decision).toMatchObject({ id: row.id, kind: "completion", source: "unknown", raw: { source: "ensemble" } })
    expect(decision.answer).toEqual({ verdict: "complete" })
  })

  test("an unknown kind keeps the row and exposes the raw value", () => {
    expect(decisionFromRow({ ...row, kind: "future-kind" })).toMatchObject({
      id: row.id,
      kind: "unknown",
      source: "model",
      raw: { kind: "future-kind" },
    })
  })

  test("a row of a removed kind is kept and read back with its stored name (PI-03)", () => {
    for (const kind of ["toolRisk", "agentRoute"]) {
      const decision = decisionFromRow({ ...row, id: `${kind}:scope`, kind, answer_json: JSON.stringify({ risk: "ALLOW" }) })
      expect(decision).toMatchObject({ id: `${kind}:scope`, kind: "unknown", raw: { kind } })
      expect(decision.answer).toEqual({ risk: "ALLOW" })
    }
  })

  test("a known row carries no raw value", () => {
    expect(decisionFromRow(row).raw).toBeUndefined()
  })

  test("a v1 `jev` row, written by an older build after the migration, reads as a model answer by that model", () => {
    const legacy = { ...row, source: "jev", provider: "jev", attempted_provider: null, provider_id: null }
    expect(decisionFromRow(legacy)).toMatchObject({ source: "model", providerID: "jev" })
    expect(decisionFromRow(legacy).raw).toBeUndefined()
  })

  test("a v1 `deterministic` row reads as the baseline", () => {
    const legacy = { ...row, source: "deterministic", provider: "deterministic", provider_id: null }
    expect(decisionFromRow(legacy)).toMatchObject({ source: "baseline" })
    expect(decisionFromRow(legacy).providerID).toBeUndefined()
  })

  test("a label is read whole, and one with an unknown outcome leaves the row unlabelled", () => {
    const labelled = decisionFromRow({
      ...row,
      label: JSON.stringify({ outcome: "incorrect", source: "episode-outcome" }),
      labeled_at: 2_000,
    })
    expect(labelled.label).toEqual({ outcome: "incorrect", source: "episode-outcome", labeledAt: 2_000 })
    expect(decisionFromRow({ ...row, label: JSON.stringify({ outcome: "maybe", source: "x" }), labeled_at: 2_000 }).label)
      .toBeUndefined()
    expect(decisionFromRow({ ...row, label: "{not json", labeled_at: 2_000 }).label).toBeUndefined()
  })
})
