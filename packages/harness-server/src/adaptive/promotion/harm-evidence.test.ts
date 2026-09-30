/**
 * Retire only on evidence of harm (ADR-0025 R18), by seeded simulation at the budget of 150 sessions
 * per arm: a harmless capability is rarely retired by noise, a clearly harmful one is, and the rates
 * match the ones the ADR states. Everything is synthetic and seeded, so the counts are fixed.
 */

import { describe, expect, test } from "bun:test"
import { EVALUATION, criteriaFor, decide } from "./criteria"
import type { Evidence } from "./criteria"
import { bootstrap, ratio, seededRandom } from "./stats"

/** A session as the completion and error-rate guardrails read it (`live-eval.ts` SESSION_STATISTICS). */
type Unit = { known: boolean; complete: boolean; turns: number; errorTurns: number }

const completion = ratio<Unit>(
  (unit) => (unit.known && unit.complete ? 1 : 0),
  (unit) => (unit.known ? 1 : 0),
)
const errorRate = ratio<Unit>(
  (unit) => unit.errorTurns,
  (unit) => unit.turns,
)

/**
 * The ADR's assumptions: 60% of sessions have a known outcome, 70% of those complete, ~8 turns per
 * session with a per-session error propensity spread over 0–20%.
 */
function arm(random: () => number, count: number, completeRate: number): Unit[] {
  return Array.from({ length: count }, () => {
    const turns = 1 + Math.floor(-Math.log(1 - random()) * 7)
    const propensity = random() * 0.2
    return {
      known: random() < 0.6,
      complete: random() < completeRate,
      turns,
      errorTurns: Array.from({ length: turns }, () => (random() < propensity ? 1 : 0)).reduce((sum: number, value) => sum + value, 0),
    }
  })
}

const trim = criteriaFor("toolTrim")
/** Everything else about the trim is fine: the primary passes and the other guardrails hold. */
const FINE: Evidence["estimates"] = {
  "uncachedInputPerSession:paired": { estimate: -0.25, low: -0.35, high: -0.15 },
  "completion:paired": { estimate: 0, low: -0.02, high: 0.02 },
  "p95TurnMs:relative": { estimate: 0, low: -0.05, high: 0.05 },
  "recallMiss:treatment": { estimate: 0.01, low: 0, high: 0.02 },
}

/** `runs` seeded evaluations at `perArm` sessions per arm, the treatment's completion `drop` lower. */
function simulate(seed: string, runs: number, perArm: number, drop: number) {
  const random = seededRandom(seed)
  const decisions = Array.from({ length: runs }, (_, index) => {
    const control = arm(random, perArm, 0.7)
    const treatment = arm(random, perArm, 0.7 - drop)
    const estimate = (statistic: typeof completion, key: string) =>
      bootstrap({
        measure: "difference",
        control,
        treatment,
        statistic,
        resamples: EVALUATION.resamples,
        seed: `${seed}:${index}:${key}`,
        confidence: EVALUATION.confidence,
      })
    const completionEstimate = estimate(completion, "completion")
    return decide(trim, {
      estimates: { ...FINE, "completion:difference": completionEstimate, "errorRate:difference": estimate(errorRate, "errorRate") },
      samples: { sessions: { control: perArm, treatment: perArm }, replayFixtures: { overall: 30 } },
      windowComplete: true,
    })
  })
  const share = (test: (result: (typeof decisions)[number]) => boolean) => decisions.filter(test).length / runs
  return {
    retired: share((result) => result.decision === "retire"),
    completionRetired: share((result) => result.decision === "retire" && result.reasons.some((reason) => reason.includes("Task completion"))),
    errorRetired: share((result) => result.decision === "retire" && result.reasons.some((reason) => reason.includes("tool or provider error"))),
    promoted: share((result) => result.decision === "promote"),
  }
}

/**
 * 200 runs: the Monte Carlo SE of a 5% rate is 1.5 pp, so the checks allow two of them above the
 * nominal one-sided 5%. That also covers the ~6–7% per guardrail the ADR states from 1,000 runs (the
 * percentile bootstrap undercovers slightly at ~90 known outcomes per arm).
 */
const RUNS = 200
const MC_TOLERANCE = 2 * Math.sqrt((0.05 * 0.95) / RUNS)

describe("retire only on evidence of harm (R18)", () => {
  test("a harmless capability at 150 per arm is retired by noise at about the one-sided 5% per guardrail", () => {
    const result = simulate("harmless-150", RUNS, EVALUATION.budget.sessionsPerArm, 0)
    expect(result.completionRetired).toBeLessThanOrEqual(0.05 + MC_TOLERANCE)
    expect(result.errorRetired).toBeLessThanOrEqual(0.05 + MC_TOLERANCE)
    // The family of these two guardrails: at most 1 − 0.95² ≈ 9.75% (the ADR states the three-guardrail bound, 14.3%).
    expect(result.retired).toBeLessThanOrEqual(1 - 0.95 ** 2 + MC_TOLERANCE)
    // The old point-estimate reading retired about half of these; the rule is the difference.
    expect(result.retired).toBeLessThan(0.2)
  }, 60_000)

  test("noise at 30 sessions per arm does not stop a harmless capability more than the same 5%", () => {
    const result = simulate("harmless-30", RUNS, EVALUATION.safetyMinSessionsPerArm, 0)
    expect(result.completionRetired).toBeLessThanOrEqual(0.05 + MC_TOLERANCE)
  }, 60_000)

  test("a clearly harmful capability (−20 pp completion) is retired", () => {
    const result = simulate("harmful-150", 50, EVALUATION.budget.sessionsPerArm, 0.2)
    expect(result.completionRetired).toBeGreaterThanOrEqual(0.8)
    expect(result.promoted).toBeLessThanOrEqual(0.05)
  }, 60_000)
})
