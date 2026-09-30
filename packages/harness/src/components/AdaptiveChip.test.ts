import { describe, expect, test } from "bun:test"
import { chipLabel, excludedWith, planText, whyDecision } from "./AdaptiveChip"
import type { SessionTurnSummary } from "../types"

const summary = (over: Partial<SessionTurnSummary> = {}): SessionTurnSummary => ({
  sessionID: "ses_1",
  override: { paused: false, excludedSkills: [] },
  ...over,
})

describe("the adaptive chip", () => {
  test("says paused in the row itself", () => {
    expect(chipLabel(undefined)).toBe("Adaptive")
    expect(chipLabel({ paused: false, excludedSkills: [] })).toBe("Adaptive")
    expect(chipLabel({ paused: true, excludedSkills: [] })).toBe("Adaptive · paused")
  })

  test("the plan line tells an applied plan from an observed one", () => {
    expect(planText(undefined)).toBe("No context plan this turn")
    expect(planText({ id: "plan:1", tokensSaved: 1200, applied: true, at: 1 })).toBe(
      `Context plan applied: −${(1200).toLocaleString()} tokens`,
    )
    expect(planText({ id: "plan:1", tokensSaved: 300, applied: false, at: 1 })).toBe(
      "Context plan observed: would save 300 tokens",
    )
  })

  test("Why? opens the skill decision first, then the plan's, then the model's", () => {
    const relevance = { decisionID: "skillRelevance:ses_1:msg_1", skills: ["alpha"], acted: true, at: 1 }
    const plan = { id: "plan:1", tokensSaved: 0, applied: false, decisionID: "contextItem:run:1", at: 1 }
    const model = { providerID: "jev", kind: "failure", latencyMs: 90, decisionID: "failure:ses_1:bash:a", at: 1 }
    expect(whyDecision(summary({ relevance, plan, model }))).toBe("skillRelevance:ses_1:msg_1")
    expect(whyDecision(summary({ plan, model }))).toBe("contextItem:run:1")
    expect(whyDecision(summary({ model }))).toBe("failure:ses_1:bash:a")
    expect(whyDecision(summary())).toBeUndefined()
    expect(whyDecision(undefined)).toBeUndefined()
  })

  test("don't suggest adds a skill once, and suggest again takes it out", () => {
    const override = { paused: false, excludedSkills: ["alpha"] }
    expect(excludedWith(override, "beta", true)).toEqual(["alpha", "beta"])
    expect(excludedWith(override, "alpha", true)).toEqual(["alpha"])
    expect(excludedWith(override, "alpha", false)).toEqual([])
  })
})
