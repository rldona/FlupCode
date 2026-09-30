import { describe, expect, test } from "bun:test"
import { confidenceText, describeAnswer, explanationFor, latencyText } from "./DecisionsPanel"
import type { DecisionExplanation } from "../types"

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
    source: "deterministic",
    provider: "baseline",
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
