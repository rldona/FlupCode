/**
 * The arithmetic of the live evaluation (AH-G02): a seeded generator and a percentile bootstrap that
 * resamples whole units (sessions, or proposals) within each arm.
 *
 * Resampling the unit of randomisation rather than turns or decisions keeps the turns of one session
 * together, so a long session cannot pass for many independent observations. The seed is fixed by
 * the criteria, so the same database always prints the same interval.
 */

import { createHash } from "node:crypto"
import type { Estimate, Measure } from "./criteria"

/** mulberry32 seeded from a string: small, fast and reproducible across runs and machines. */
export function seededRandom(seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const next = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

/** A statistic over a set of units; undefined when the set cannot carry it (an empty denominator). */
export type Statistic<T> = (units: readonly T[]) => number | undefined

/**
 * The point estimate and percentile CI of one measure. For `relative` and `difference` both arms are
 * resampled independently each round; for a single-arm measure only `treatment` (or the one set
 * passed as it) is. Rounds whose statistic is undefined are dropped; with none left there is no CI.
 */
export function bootstrap<T>(input: {
  measure: Measure
  control: readonly T[]
  treatment: readonly T[]
  statistic: Statistic<T>
  resamples: number
  seed: string
  confidence: number
}): Estimate {
  const combine = (control: readonly T[], treatment: readonly T[]) => {
    if (input.measure === "control") return input.statistic(control)
    if (input.measure === "treatment" || input.measure === "overall") return input.statistic(treatment)
    const c = input.statistic(control)
    const t = input.statistic(treatment)
    if (c === undefined || t === undefined) return undefined
    if (input.measure === "difference") return t - c
    return c === 0 ? undefined : t / c - 1
  }
  const estimate = combine(input.control, input.treatment)
  if (estimate === undefined) return {}
  const random = seededRandom(input.seed)
  const draw = (units: readonly T[]) => Array.from({ length: units.length }, () => units[Math.floor(random() * units.length)]!)
  const rounds = Array.from({ length: input.resamples }, () => combine(draw(input.control), draw(input.treatment)))
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .toSorted((a, b) => a - b)
  if (rounds.length === 0) return { estimate }
  const tail = (1 - input.confidence) / 2
  return { estimate, low: quantile(rounds, tail), high: quantile(rounds, 1 - tail) }
}

/** The linear-interpolated quantile of an already sorted list. */
export function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.min(sorted.length - 1, below + 1)
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below)
}

/** Σ numerator ÷ Σ denominator over the units: the ratio estimator a per-unit mean or rate is. */
export function ratio<T>(numerator: (unit: T) => number, denominator: (unit: T) => number): Statistic<T> {
  return (units) => {
    const bottom = units.reduce((sum, unit) => sum + denominator(unit), 0)
    return bottom === 0 ? undefined : units.reduce((sum, unit) => sum + numerator(unit), 0) / bottom
  }
}
