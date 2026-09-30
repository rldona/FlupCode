/**
 * The preregistered criteria (AH-G01): the ADR a person approves and the constants the report
 * applies are the same, every minimum sample is the power calculation it claims to be, and the
 * decision table takes each of its branches.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CRITERIA,
  EVALUATION,
  POWER_ASSUMPTIONS,
  checkKey,
  criteriaFor,
  decide,
  futile,
  renderCriteriaTable,
  sampleForLogMeans,
  sampleForOneProportion,
  sampleForPaired,
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

  test("every minimum sample is the one its stated assumption gives, and fits its budget", () => {
    for (const criteria of CRITERIA)
      for (const requirement of criteria.sample) {
        const power: Partial<Record<string, { minimum: number; budget: number }>> = POWER_ASSUMPTIONS[criteria.id]
        const stated = power[requirement.counter]
        expect(stated, `${criteria.id} states no assumption for ${requirement.counter}`).toBeDefined()
        expect(requirement.min).toBe(stated!.minimum)
        expect(requirement.min, `${criteria.id}: ${requirement.counter} exceeds its budget`).toBeLessThanOrEqual(stated!.budget)
      }
  })

  test("no live session minimum exceeds the owner's budget of 150 per arm", () => {
    const budget = EVALUATION.budget
    expect(budget.sessionsPerArm).toBeLessThanOrEqual((budget.sessionsPerWeek * budget.weeks) / 2)
    for (const criteria of CRITERIA)
      for (const requirement of criteria.sample.filter((entry) => entry.counter === "sessions"))
        expect(requirement.min).toBeLessThanOrEqual(budget.sessionsPerArm)
  })

  test("the minimums recompute from one-sided α = 0.05 and power 0.8", () => {
    // n = (z₀.₉₅ + z₀.₈)² … with z₀.₉₅ = 1.645 (one-sided) instead of the old z₀.₉₇₅ = 1.960.
    const k = (1.644854 + 0.841621) ** 2
    expect(sampleForLogMeans(1, -0.25)).toBe(Math.ceil(2 * k * (1 / Math.log(0.75)) ** 2))
    expect(sampleForLogMeans(1, -0.25)).toBe(150)
    expect(sampleForPaired(0.3, -0.15)).toBe(Math.ceil(k * (0.3 / Math.log(0.85)) ** 2))
    expect(sampleForPaired(0.3, -0.15)).toBe(22)
    expect(sampleForPaired(0.5, -0.25)).toBe(19)
    expect(sampleForProportions(0.5, 0.62, 1.5)).toBe(313)
    expect(sampleForProportions(0.5, 0.62)).toBe(209)
    expect(sampleForProportions(0.2, 0.6)).toBe(16)
    expect(sampleForOneProportion(0.5, 0.625)).toBe(97)
    // The old two-sided 15% effect on raw means, for the record: out of reach at 150 per arm.
    expect(Math.ceil(2 * (1.959964 + 0.841621) ** 2 * (1 / 0.15) ** 2)).toBe(698)
  })

  test("the capabilities a paired replay decides name its command, and only they read paired checks", () => {
    const replayed = CRITERIA.filter((criteria) => criteria.instrument === "replay")
    expect(replayed.map((criteria) => criteria.id)).toEqual(["toolTrim", "selection", "anchors"])
    for (const criteria of CRITERIA) {
      const paired = [...criteria.primary, ...criteria.guardrails].some((check) => check.measure === "paired")
      expect(paired).toBe(criteria.instrument === "replay")
      expect(criteria.replay !== undefined).toBe(criteria.instrument === "replay")
      if (criteria.instrument === "replay") expect(criteria.primary.every((check) => check.measure === "paired")).toBe(true)
    }
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
    "uncachedInputPerSession:paired": { estimate: -0.2, low: -0.3, high: -0.1 },
    "completion:paired": { estimate: 0, low: -0.02, high: 0.02 },
    "completion:difference": { estimate: 0, low: -0.03, high: 0.03 },
    "errorRate:difference": { estimate: 0, low: -0.01, high: 0.01 },
    "p95TurnMs:relative": { estimate: 0.02, low: -0.05, high: 0.08 },
    "recallMiss:treatment": { estimate: 0.01, low: 0, high: 0.02 },
  }
  const evidence = (estimates: Evidence["estimates"], extra: Partial<Evidence> = {}): Evidence => ({
    estimates,
    samples: { sessions: full, replayFixtures: { overall: 30 } },
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

  test("past the 6-week cap a short sample is final insufficient data; a full one is analysed", () => {
    const capped = decide(trim, evidence(good, { windowCapped: true, samples: { sessions: { control: 90, treatment: 95 }, replayFixtures: { overall: 30 } } }))
    expect(capped.decision).toBe("insufficient data")
    expect(capped.reasons).toEqual(["below 150 sessions per arm", "the 6-week cap passed: final, the window is not extended"])
    expect(decide(trim, evidence(good, { windowCapped: true })).decision).toBe("promote")
  })

  test("a replay-decided capability waits for its paired fixtures, whatever the live sample", () => {
    const noReplay = decide(trim, evidence(good, { samples: { sessions: full, replayFixtures: { overall: 0 } } }))
    expect(noReplay.decision).toBe("insufficient data")
    expect(noReplay.reasons).toEqual(["below 22 paired replay fixtures (3 repetitions per variant)"])
    const lostCompletion = decide(trim, evidence({ ...good, "completion:paired": { estimate: -0.03, low: -0.08, high: 0.01 } }))
    expect(lostCompletion.decision).toBe("retire")
    expect(lostCompletion.reasons[0]).toStartWith("guardrail failed: Task completion, replay (paired")
  })

  test("an open window or a short sample is insufficient data", () => {
    expect(decide(trim, evidence(good, { windowComplete: false })).decision).toBe("insufficient data")
    const short = decide(trim, evidence(good, { samples: { sessions: { control: 100, treatment: 1000 }, replayFixtures: { overall: 30 } } }))
    expect(short.decision).toBe("insufficient data")
    expect(short.reasons).toEqual(["below 150 sessions per arm"])
  })

  test("a failed guardrail retires", () => {
    const result = decide(trim, evidence({ ...good, "completion:difference": { estimate: -0.02 } }))
    expect(result.decision).toBe("retire")
    expect(result.reasons[0]).toStartWith("guardrail failed")
  })

  test("a primary whose CI cannot reach the threshold retires; an inconclusive one keeps observing", () => {
    expect(decide(trim, evidence({ ...good, "uncachedInputPerSession:paired": { estimate: -0.05, low: -0.1, high: 0 } })).decision).toBe("retire")
    expect(decide(trim, evidence({ ...good, "uncachedInputPerSession:paired": { estimate: -0.1, low: -0.25, high: 0.02 } })).decision).toBe(
      "keep observing",
    )
  })

  test("skill suggestion promotes on either primary (§14.3's 'or')", () => {
    const relevance = criteriaFor("relevance")
    const base = {
      ...good,
      "relevanceCorrect:relative": { estimate: 0.01, low: -0.05, high: 0.08 },
      "toolCallsPerSession:geometric": { estimate: -0.3, low: -0.42, high: -0.15 },
    }
    const samples = { sessions: full, judgedRelevance: { control: 400, treatment: 400 } }
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
