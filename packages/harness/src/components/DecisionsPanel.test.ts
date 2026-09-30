import { describe, expect, test } from "bun:test"
import {
  DECISION_KIND_TITLES,
  actedText,
  confidenceBandText,
  confidenceText,
  costText,
  decisionActed,
  decisionQuery,
  describeAnswer,
  explanationFor,
  gateStateText,
  gateSummary,
  kindText,
  kindTitle,
  labelMark,
  latencyText,
  outcomeText,
  sourceText,
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

describe("a usable audit (AH-E05)", () => {
  test("a kind reads as a title, and one this build does not know as its stored value", () => {
    expect(kindTitle({ kind: "skillRelevance" })).toBe("Which skills fit")
    expect(kindTitle({ kind: "unknown", raw: { kind: "future-kind" } })).toBe("future-kind")
    setLocale("es")
    expect(kindTitle({ kind: "skillRelevance" })).toBe("Qué skills encajan")
    setLocale("en")
  })

  test("every kind the filter offers has a title in Spanish too", () => {
    setLocale("es")
    const untranslated = Object.keys(DECISION_KIND_TITLES).filter((kind) => kindTitle({ kind }) === DECISION_KIND_TITLES[kind])
    setLocale("en")
    expect(untranslated).toEqual([])
  })

  test("only a non-shadow row outside the holdout control arm acted", () => {
    expect(decisionActed({ shadow: false })).toBe(true)
    expect(decisionActed({ shadow: false, arm: "treatment" })).toBe(true)
    expect(decisionActed({ shadow: false, arm: "control" })).toBe(false)
    expect(decisionActed({ shadow: true })).toBe(false)
    expect(actedText({ shadow: false })).toBe("Acted")
    setLocale("es")
    expect(actedText({ shadow: false })).toBe("Actuó")
    expect(actedText({ shadow: true })).toBe("Solo registrado")
    setLocale("en")
  })

  test("confidence reads as a band with its percentage, split at 80% and 50%", () => {
    expect(confidenceBandText(0.82)).toBe("High (82%)")
    expect(confidenceBandText(0.8)).toBe("High (80%)")
    expect(confidenceBandText(0.79)).toBe("Medium (79%)")
    expect(confidenceBandText(0.5)).toBe("Medium (50%)")
    expect(confidenceBandText(0.12)).toBe("Low (12%)")
    expect(confidenceBandText(undefined)).toBeUndefined()
    setLocale("es")
    expect(confidenceBandText(0.82)).toBe("Alta (82%)")
    setLocale("en")
  })

  test("the source says who answered, and an unknown one keeps its stored value", () => {
    expect(sourceText({ source: "baseline" })).toBe("Built-in rules")
    expect(sourceText({ source: "model" })).toBe("Model")
    expect(sourceText({ source: "fallback" })).toBe("Rules after the model")
    expect(sourceText({ source: "unknown", raw: { source: "oracle" } })).toBe("oracle")
  })

  test("a filter set to all asks the server for nothing, and the others for what they name", () => {
    expect(decisionQuery({ kind: "", acted: "all" })).toEqual({})
    expect(decisionQuery({ sessionID: "ses_1", kind: "completion", acted: "acted" })).toEqual({
      sessionID: "ses_1",
      kind: "completion",
      acted: true,
    })
    expect(decisionQuery({ kind: "", acted: "recorded" })).toEqual({ acted: false })
  })
})
