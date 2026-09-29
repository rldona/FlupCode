import { describe, expect, test } from "bun:test"
import { confidenceText, describeAnswer, latencyText } from "./DecisionsPanel"

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
