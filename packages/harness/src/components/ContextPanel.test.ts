import { describe, expect, test } from "bun:test"
import { scoreSourceText } from "./ContextPanel"

describe("who scored a context plan (AH-C02)", () => {
  test("a model refinement names the model that refined it", () => {
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "small-llm" })).toBe("Refined by small-llm")
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "jev" })).toBe("Refined by jev")
  })

  test("the scorer alone is deterministic, and a source this build does not know is shown as stored", () => {
    expect(scoreSourceText({ scoreSource: "baseline" })).toBe("Deterministic")
    expect(scoreSourceText({ scoreSource: "unknown", rawScoreSource: "ensemble" })).toBe("ensemble")
  })
})
