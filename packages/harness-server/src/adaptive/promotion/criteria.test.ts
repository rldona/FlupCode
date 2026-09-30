/**
 * The preregistered criteria (AH-G01): the ADR a person approves and the constants the report
 * applies are the same, every minimum sample is the power calculation it claims to be, and the
 * decision table takes each of its branches.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CRITERIA,
  POWER_ASSUMPTIONS,
  checkKey,
  criteriaFor,
  decide,
  futile,
  renderCriteriaTable,
  sampleForMeans,
  sampleForOneProportion,
  sampleForProportions,
  verdictOf,
} from "./criteria"
import type { Check, Evidence } from "./criteria"

const ADR = join(import.meta.dir, "../../../../../docs/adr/0025-promotion-criteria.md")

describe("ADR-0025 and the criteria module", () => {
  test("the ADR embeds exactly the generated table", async () => {
    const text = await Bun.file(ADR).text()
    const block = text.match(/<!-- criteria:begin[^>]*-->\n([\s\S]*?)\n<!-- criteria:end -->/)
    expect(block).not.toBeNull()
    expect(block![1]).toBe(renderCriteriaTable())
  })

  test("the ADR is a proposal until the owner accepts it", async () => {
    const text = await Bun.file(ADR).text()
    expect(text).toMatch(/- \*\*Status:\*\* (Proposed|Accepted)/)
  })

  test("every minimum sample is the power calculation of its stated assumption", () => {
    for (const criteria of CRITERIA)
      expect(criteria.sample[0]!.min).toBe(POWER_ASSUMPTIONS[criteria.id].minimum)
    expect(sampleForMeans(1, 0.15)).toBe(698)
    expect(sampleForMeans(1, 0.25)).toBe(252)
    expect(sampleForProportions(0.5, 0.55)).toBe(1562)
    expect(sampleForProportions(0.2, 0.5)).toBe(36)
    expect(sampleForOneProportion(0.5, 0.6)).toBe(194)
  })

  test("every capability that splits sessions names a holdout capability, and only model and learning do not", () => {
    expect(CRITERIA.filter((criteria) => criteria.holdout === null).map((criteria) => criteria.id)).toEqual(["model", "learning"])
  })
})

describe("a check", () => {
  const lower: Check = { metric: "uncachedInputPerSession", measure: "relative", op: "<=", threshold: -0.15, significant: true }
  const higher: Check = { metric: "uplift", measure: "overall", op: ">", threshold: 0, significant: true }

  test("passes only past the threshold with the CI clear of zero on the good side", () => {
    expect(verdictOf(lower, { estimate: -0.2, low: -0.3, high: -0.1 })).toBe("pass")
    expect(verdictOf(lower, { estimate: -0.2, low: -0.4, high: 0.05 })).toBe("fail")
    expect(verdictOf(lower, { estimate: -0.1, low: -0.2, high: -0.05 })).toBe("fail")
    expect(verdictOf(higher, { estimate: 0.2, low: 0.05, high: 0.3 })).toBe("pass")
    expect(verdictOf(higher, { estimate: 0.2, low: -0.05, high: 0.3 })).toBe("fail")
    expect(verdictOf(lower, {})).toBe("unknown")
  })

  test("is futile when the whole CI is on the wrong side of the threshold", () => {
    expect(futile(lower, { estimate: -0.05, low: -0.1, high: 0 })).toBe(true)
    expect(futile(lower, { estimate: -0.1, low: -0.2, high: 0 })).toBe(false)
    expect(futile(higher, { estimate: -0.2, low: -0.3, high: -0.1 })).toBe(true)
  })
})

describe("the decision table", () => {
  const trim = criteriaFor("toolTrim")
  const full = { control: 1000, treatment: 1000 }
  const good: Evidence["estimates"] = {
    "uncachedInputPerSession:relative": { estimate: -0.2, low: -0.3, high: -0.1 },
    "completion:difference": { estimate: 0, low: -0.03, high: 0.03 },
    "errorRate:difference": { estimate: 0, low: -0.01, high: 0.01 },
    "p95TurnMs:relative": { estimate: 0.02, low: -0.05, high: 0.08 },
    "recallMiss:treatment": { estimate: 0.01, low: 0, high: 0.02 },
  }
  const evidence = (estimates: Evidence["estimates"], extra: Partial<Evidence> = {}): Evidence => ({
    estimates,
    samples: { sessions: full },
    windowComplete: true,
    ...extra,
  })

  test("promotes when every primary passes and every guardrail holds", () => {
    expect(decide(trim, evidence(good)).decision).toBe("promote")
  })

  test("a safety stop retires even before the window closes", () => {
    const result = decide(trim, evidence({ ...good, "completion:difference": { estimate: -0.08 } }, { windowComplete: false }))
    expect(result.decision).toBe("retire")
    expect(result.reasons[0]).toStartWith("safety stop")
  })

  test("a safety stop on a session metric waits for 30 sessions per arm", () => {
    const early = evidence({ "completion:difference": { estimate: -0.5 } }, { samples: { sessions: { control: 5, treatment: 20 } }, windowComplete: false })
    expect(decide(trim, early).decision).toBe("insufficient data")
  })

  test("an open window or a short sample is insufficient data", () => {
    expect(decide(trim, evidence(good, { windowComplete: false })).decision).toBe("insufficient data")
    const short = decide(trim, evidence(good, { samples: { sessions: { control: 100, treatment: 1000 } } }))
    expect(short.decision).toBe("insufficient data")
    expect(short.reasons).toEqual(["below 698 sessions per arm"])
  })

  test("a failed guardrail retires", () => {
    const result = decide(trim, evidence({ ...good, "completion:difference": { estimate: -0.02 } }))
    expect(result.decision).toBe("retire")
    expect(result.reasons[0]).toStartWith("guardrail failed")
  })

  test("a primary whose CI cannot reach the threshold retires; an inconclusive one keeps observing", () => {
    expect(decide(trim, evidence({ ...good, "uncachedInputPerSession:relative": { estimate: -0.05, low: -0.1, high: 0 } })).decision).toBe("retire")
    expect(decide(trim, evidence({ ...good, "uncachedInputPerSession:relative": { estimate: -0.1, low: -0.25, high: 0.02 } })).decision).toBe(
      "keep observing",
    )
  })

  test("skill suggestion promotes on either primary (§14.3's 'or')", () => {
    const relevance = criteriaFor("relevance")
    const base = {
      ...good,
      "relevanceCorrect:relative": { estimate: 0.01, low: -0.05, high: 0.08 },
      "toolCallsPerSession:relative": { estimate: -0.08, low: -0.12, high: -0.03 },
    }
    const samples = { sessions: full, judgedRelevance: { control: 2000, treatment: 2000 } }
    expect(decide(relevance, { estimates: base, samples, windowComplete: true }).decision).toBe("promote")
  })

  test("a required guardrail nobody can measure blocks promotion; an optional one does not", () => {
    const learning = criteriaFor("learning")
    const samples = { decidedProposals: { overall: 20 }, promotedWithClosedWindow: { overall: 5 } }
    const estimates = {
      "approvalRate:overall": { estimate: 0.3, low: 0.1, high: 0.5 },
      "approvedSkillsUsed:overall": { estimate: 0.8, low: 0.4, high: 1 },
    }
    expect(decide(learning, { estimates, samples, windowComplete: true }).decision).toBe("keep observing")
    expect(
      decide(learning, { estimates: { ...estimates, "contentIncidents:overall": { estimate: 0 } }, samples, windowComplete: true }).decision,
    ).toBe("promote")
  })

  test("a threshold from the config snapshot replaces the default", () => {
    const model = criteriaFor("model")
    const estimates = {
      "uplift:overall": { estimate: 0.3, low: 0.1, high: 0.5 },
      "costPerUsefulDecision:overall": { estimate: 0.08 },
    }
    const samples = { judgedDisagreements: { overall: 500 } }
    expect(decide(model, { estimates, samples, windowComplete: true }).decision).toBe("retire")
    const key = checkKey({ metric: "costPerUsefulDecision", measure: "overall" })
    expect(decide(model, { estimates, samples, windowComplete: true, thresholds: { [key]: 0.1 } }).decision).toBe("promote")
  })
})
