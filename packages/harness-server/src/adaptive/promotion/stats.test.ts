/**
 * The bootstrap on distributions whose answer is known: its interval matches the analytical one,
 * it is reproducible from its seed, and a statistic an arm cannot carry yields no interval.
 */

import { describe, expect, test } from "bun:test"
import { bootstrap, cuped, quantile, ratio, seededRandom } from "./stats"

/** Box–Muller normals from the seeded generator, so the samples themselves are fixed. */
function normals(seed: string, count: number, mean: number, sd: number) {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => {
    const u = 1 - random()
    const v = random()
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  })
}

const mean = ratio<number>((value) => value, () => 1)
const options = { resamples: 2000, seed: "test", confidence: 0.95 }

describe("the bootstrap", () => {
  test("a difference of means matches the normal-theory interval", () => {
    const control = normals("c", 400, 9, 2)
    const treatment = normals("t", 400, 10, 2)
    const result = bootstrap({ measure: "difference", control, treatment, statistic: mean, ...options })
    const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    const variance = (values: number[]) => values.reduce((sum, value) => sum + (value - avg(values)) ** 2, 0) / (values.length - 1)
    const diff = avg(treatment) - avg(control)
    const se = Math.sqrt(variance(treatment) / treatment.length + variance(control) / control.length)
    expect(result.estimate).toBeCloseTo(diff, 10)
    expect(Math.abs(result.low! - (diff - 1.96 * se))).toBeLessThan(0.04)
    expect(Math.abs(result.high! - (diff + 1.96 * se))).toBeLessThan(0.04)
    // The true difference is 1, and the sample's interval covers it.
    expect(result.low!).toBeLessThan(1)
    expect(result.high!).toBeGreaterThan(1)
  })

  test("a difference of proportions matches the Wald interval", () => {
    const control = Array.from({ length: 500 }, (_, index) => (index < 150 ? 1 : 0))
    const treatment = Array.from({ length: 500 }, (_, index) => (index < 250 ? 1 : 0))
    const result = bootstrap({ measure: "difference", control, treatment, statistic: mean, ...options })
    const se = Math.sqrt((0.3 * 0.7) / 500 + (0.5 * 0.5) / 500)
    expect(result.estimate).toBeCloseTo(0.2, 10)
    expect(Math.abs(result.low! - (0.2 - 1.96 * se))).toBeLessThan(0.01)
    expect(Math.abs(result.high! - (0.2 + 1.96 * se))).toBeLessThan(0.01)
  })

  test("a relative change is treatment ÷ control − 1, and a single-arm measure reads one arm", () => {
    const control = Array.from({ length: 200 }, () => 100)
    const treatment = Array.from({ length: 200 }, () => 80)
    expect(bootstrap({ measure: "relative", control, treatment, statistic: mean, ...options })).toEqual({
      estimate: -0.19999999999999996,
      low: -0.19999999999999996,
      high: -0.19999999999999996,
    })
    expect(bootstrap({ measure: "control", control, treatment, statistic: mean, ...options }).estimate).toBe(100)
    expect(bootstrap({ measure: "treatment", control, treatment, statistic: mean, ...options }).estimate).toBe(80)
  })

  test("the same seed gives the same interval, another seed a different one", () => {
    const control = normals("c", 100, 5, 3)
    const treatment = normals("t", 100, 6, 3)
    const run = (seed: string) => bootstrap({ measure: "difference", control, treatment, statistic: mean, ...options, seed })
    expect(run("a")).toEqual(run("a"))
    expect(run("a").low).not.toBe(run("b").low)
  })

  test("an arm that cannot carry the statistic gives no estimate", () => {
    expect(bootstrap({ measure: "difference", control: [], treatment: [1, 2], statistic: mean, ...options })).toEqual({})
    expect(bootstrap({ measure: "relative", control: [0, 0], treatment: [1, 2], statistic: mean, ...options })).toEqual({})
  })

  test("ratio sums numerators and denominators, and an empty denominator is undefined", () => {
    const rate = ratio<{ hits: number; tries: number }>((unit) => unit.hits, (unit) => unit.tries)
    expect(rate([{ hits: 1, tries: 4 }, { hits: 3, tries: 4 }])).toBe(0.5)
    expect(rate([{ hits: 0, tries: 0 }])).toBeUndefined()
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(quantile([0, 10], 0.25)).toBe(2.5)
  })

  test("a 90% interval is the one-sided 5% bound: ±1.645 standard errors", () => {
    const control = normals("c90", 400, 9, 2)
    const treatment = normals("t90", 400, 10, 2)
    const result = bootstrap({ measure: "difference", control, treatment, statistic: mean, ...options, confidence: 0.9 })
    const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    const variance = (values: number[]) => values.reduce((sum, value) => sum + (value - avg(values)) ** 2, 0) / (values.length - 1)
    const diff = avg(treatment) - avg(control)
    const se = Math.sqrt(variance(treatment) / treatment.length + variance(control) / control.length)
    expect(Math.abs(result.low! - (diff - 1.645 * se))).toBeLessThan(0.04)
    expect(Math.abs(result.high! - (diff + 1.645 * se))).toBeLessThan(0.04)
  })

  test("geometric is exp(mean log T − mean log C) − 1: the ratio of geometric means", () => {
    // Log-normal sessions: the geometric means are e^7 and e^6.7, so the ratio is e^−0.3 − 1 ≈ −25.9%.
    const control = normals("gc", 3000, 7, 1).map((log) => Math.exp(log))
    const treatment = normals("gt", 3000, 6.7, 1).map((log) => Math.exp(log))
    const logMean = ratio<number>((value) => Math.log(value), () => 1)
    const result = bootstrap({ measure: "geometric", control, treatment, statistic: logMean, ...options, confidence: 0.9 })
    const exact = Math.exp(logMean(treatment)! - logMean(control)!) - 1
    expect(result.estimate).toBeCloseTo(exact, 12)
    expect(result.estimate!).toBeCloseTo(Math.exp(-0.3) - 1, 1)
    expect(result.low!).toBeLessThan(result.estimate!)
    expect(result.high!).toBeLessThan(0)
    // The same data on raw means is dominated by the tail: a far wider interval.
    const raw = bootstrap({ measure: "relative", control, treatment, statistic: mean, ...options, confidence: 0.9 })
    expect(raw.high! - raw.low!).toBeGreaterThan(result.high! - result.low!)
  })

  test("a paired measure resamples the pairs passed as treatment, whole", () => {
    const pairs = [
      { t: 80, b: 100 },
      { t: 45, b: 50 },
      { t: 180, b: 200 },
    ]
    const statistic = (units: readonly { t: number; b: number }[]) => units.reduce((sum, unit) => sum + unit.t / unit.b, 0) / units.length - 1
    const result = bootstrap({ measure: "paired", control: [], treatment: pairs, statistic, ...options })
    expect(result.estimate).toBeCloseTo(-0.1333, 3)
    // Every resample is a mix of the three pairs' own ratios (−20%, −10%, −10%), never beyond them.
    expect(result.low!).toBeGreaterThanOrEqual(-0.2 - 1e-9)
    expect(result.high!).toBeLessThanOrEqual(-0.1 + 1e-9)
  })
})

describe("CUPED", () => {
  test("removes the variance a pre-period covariate explains, and keeps the mean", () => {
    const random = seededRandom("cuped")
    const units = Array.from({ length: 500 }, () => {
      const project = random() * 4
      return { y: project + (random() - 0.5), x: project + (random() - 0.5) * 0.2 }
    })
    const adjusted = cuped(units)
    const variance = (values: number[]) => {
      const m = values.reduce((a, b) => a + b, 0) / values.length
      return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length
    }
    expect(adjusted.theta).toBeGreaterThan(0.9)
    expect(adjusted.theta).toBeLessThan(1.1)
    expect(variance(adjusted.values)).toBeLessThan(variance(units.map((unit) => unit.y)) / 5)
    const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    expect(avg(adjusted.values)).toBeCloseTo(avg(units.map((unit) => unit.y)), 10)
  })

  test("without covariates, or without variance in them, nothing changes", () => {
    expect(cuped([{ y: 1 }, { y: 5 }, { y: 3, x: 2 }])).toEqual({ values: [1, 5, 3], theta: 0 })
    expect(cuped([{ y: 1, x: 2 }, { y: 5, x: 2 }])).toEqual({ values: [1, 5], theta: 0 })
    // A unit without a covariate keeps its value while the others are adjusted.
    const mixed = cuped([{ y: 1, x: 0 }, { y: 3, x: 2 }, { y: 10 }])
    expect(mixed.theta).toBe(1)
    expect(mixed.values).toEqual([2, 2, 10])
  })
})
