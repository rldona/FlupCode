import { describe, expect, test } from "bun:test"
import {
  confidenceText,
  costText,
  describeAnswer,
  explanationFor,
  gateStateText,
  gateSummary,
  kindText,
  labelMark,
  latencyText,
  outcomeText,
} from "./DecisionsPanel"
import type { DecisionExplanation, ValueGateStatus } from "../types"
import { setLocale } from "../i18n"

describe("an answer as one line", () => {
  test("a scalar is itself", () => {
    expect(describeAnswer(true)).toBe("true")
    expect(describeAnswer("not_complete")).toBe("not_complete")
  })

  test("an object lists its keys, and an array its entries", () => {
    expect(describeAnswer({ load: ["a", "b"] })).toBe("load: a, b")
    expect(describeAnswer([{ id: "x", disposition: "archive" }])).toBe("id: x · disposition: archive")
  })

  test("nothing at all is a dash, not the word undefined", () => {
    expect(describeAnswer(undefined)).toBe("—")
    expect(describeAnswer(null)).toBe("—")
  })
})

describe("how the numbers are said", () => {
  test("confidence is a percentage, and absent is nothing to show", () => {
    expect(confidenceText(0.87)).toBe("87%")
    expect(confidenceText(undefined)).toBeUndefined()
  })

  test("latency keeps milliseconds under a second", () => {
    expect(latencyText(240)).toBe("240 ms")
    expect(latencyText(1500)).toBe("1.5 s")
  })
})

describe("the explanation in the dialog", () => {
  const detail = (id: string): DecisionExplanation => ({
    id,
    question: `why ${id}`,
    answer: true,
    baseline: { answer: false, rule: "default" },
    why: "because",
    source: "baseline",
    provider: "deterministic",
    latencyMs: 12,
    degraded: false,
    evidenceRefs: [],
    decidedAt: 0,
  })

  test("is the one read for the decision that is open", () => {
    expect(explanationFor({ id: "b", detail: detail("b") }, "b")?.question).toBe("why b")
  })

  test("is nothing while another decision's answer is all there is, so the dialog says it is reading", () => {
    // The resource keeps the last value while the next id loads, and after that id fails.
    expect(explanationFor({ id: "a", detail: detail("a") }, "b")).toBeUndefined()
    expect(explanationFor(undefined, "b")).toBeUndefined()
  })
})

describe("the provider-neutral audit (AH-C02)", () => {
  test("a model's cost reads in dollars and input tokens, and an unmeasured one is nothing", () => {
    expect(costText(0.0031, 812)).toBe("$0.0031 · 812 input tokens")
    expect(costText(0, 0)).toBe("$0.0000 · 0 input tokens")
    expect(costText(undefined, undefined)).toBeUndefined()
  })

  test("a kind this build does not know is shown by the value stored", () => {
    expect(kindText({ kind: "unknown", raw: { kind: "future-kind" } })).toBe("future-kind")
    expect(kindText({ kind: "completion" })).toBe("completion")
  })
})

describe("the real outcome (AH-C06)", () => {
  test("a row carries a tick, a cross or a question mark, and nothing before it is labelled", () => {
    expect(labelMark({ outcome: "correct", source: "skill-loads", labeledAt: 1 })).toBe("✓")
    expect(labelMark({ outcome: "incorrect", source: "skill-loads", labeledAt: 1 })).toBe("✗")
    expect(labelMark({ outcome: "unknown", source: "max-age", labeledAt: 1 })).toBe("?")
    expect(labelMark(undefined)).toBeUndefined()
  })

  test("the dialog says the outcome in words", () => {
    expect(outcomeText("correct")).toBe("Correct")
    expect(outcomeText("incorrect")).toBe("Incorrect")
    expect(outcomeText("unknown")).toBe("Not judgeable")
  })
})

describe("the value-of-information gate (AH-C05)", () => {
  const gate = (state: ValueGateStatus["state"], extra: Partial<ValueGateStatus> = {}): ValueGateStatus => ({
    kind: "skillRelevance",
    modelID: "jev",
    state,
    samples: 200,
    disagreements: 40,
    disagreementRate: 0.2,
    uplift: 0,
    valueUsd: 0,
    costUsd: 0.001,
    latencySamples: 0,
    ...extra,
  })

  test("a paused kind says the model does not improve the decision", () => {
    expect(gateStateText("paused")).toBe("The predictive model does not improve this decision; paused")
    expect(gateSummary(gate("paused"))).toBe(
      "The predictive model does not improve this decision; paused · 200 samples · disagreement 20% · uplift 0 pp",
    )
  })

  test("an asked kind shows its uplift with a sign and its p95", () => {
    expect(gateSummary(gate("asking", { uplift: 0.314, p95LatencyMs: 240 }))).toBe(
      "Asking the model · 200 samples · disagreement 20% · uplift +31 pp · p95 240 ms",
    )
    expect(gateStateText("warming-up")).toBe("Warming up")
  })

  test("reads in Spanish", () => {
    setLocale("es")
    expect(gateStateText("paused")).toBe("El modelo predictivo no mejora esta decisión; en pausa")
    expect(gateStateText("exploring")).toBe("Solo exploración: su valor no cubre su coste")
    setLocale("en")
  })
})
