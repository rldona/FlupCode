import { describe, expect, test } from "bun:test"
import { scoreSourceText } from "./ContextPanel"

describe("who scored a context plan (AH-C02)", () => {
  test("a model refinement names the model that refined it, by its registry name", () => {
    const models = [
      { id: "jev", name: "Jev", locality: "remote" as const, supports: [], needsConsent: true, needsKey: true },
      { id: "small-llm", name: "Small model (through the engine)", locality: "remote" as const, supports: [], needsConsent: true, needsKey: false },
    ]
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "small-llm" }, models)).toBe(
      "Refined by Small model (through the engine)",
    )
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "jev" }, models)).toBe("Refined by Jev")
    // An id the registry does not hold, such as an old plan from a removed provider, is shown as stored.
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "gone" }, models)).toBe("Refined by gone")
    expect(scoreSourceText({ scoreSource: "model", scoreProvider: "jev" })).toBe("Refined by jev")
  })

  test("the scorer alone is deterministic, and a source this build does not know is shown as stored", () => {
    expect(scoreSourceText({ scoreSource: "baseline" })).toBe("Deterministic")
    expect(scoreSourceText({ scoreSource: "unknown", rawScoreSource: "ensemble" })).toBe("ensemble")
  })
})
