/**
 * Usage accounting for learned skills (FH-043).
 *
 * A learned skill is judged by how often it was *selected for the objective it should serve*, never by
 * wall-clock: `load / opportunities`, where an opportunity is one `skillRelevance` decision whose
 * roster included the skill, counted from creation. `view` counts only the harness re-reading a body
 * to prepare a patch (ADR-0019 §5); there is still no seam to observe the model opening a skill, so a
 * zero `view` remains *unknown*, not *unused*.
 *
 * The counters are cumulative; the lifecycle needs a window ("no use since the last transition"), so
 * `usageDelta` subtracts a baseline and the store keeps that baseline beside the counters. Everything
 * here is pure, which is what lets the lifecycle and the curator share one arithmetic.
 */

import type { SkillUsage } from "./learned-store"

export const EMPTY_USAGE: SkillUsage = { load: 0, view: 0, patch: 0, opportunities: 0 }

/** The counters as they moved since a baseline; never negative, because the baseline only advances. */
export function usageDelta(usage: SkillUsage, since: SkillUsage): SkillUsage {
  return {
    load: Math.max(usage.load - since.load, 0),
    view: Math.max(usage.view - since.view, 0),
    patch: Math.max(usage.patch - since.patch, 0),
    opportunities: Math.max(usage.opportunities - since.opportunities, 0),
  }
}

/** One counter moved by one; the shape every selection or write updates. */
export function bumpUsage(usage: SkillUsage, kind: "load" | "view" | "patch" | "opportunities"): SkillUsage {
  return { ...usage, [kind]: usage[kind] + 1 }
}

export const sameUsage = (left: SkillUsage, right: SkillUsage): boolean =>
  left.load === right.load &&
  left.view === right.view &&
  left.patch === right.patch &&
  left.opportunities === right.opportunities

/**
 * The opportunity-relative recall rate: selections over the chances it had, from creation.
 *
 * `max(opportunities, 1)` keeps a skill that has never had an opportunity at rate 0 instead of a
 * division by zero, so "not yet measured" reads as 0 rather than as a crash or as undefined.
 */
export const recallRate = (usage: SkillUsage): number => usage.load / Math.max(usage.opportunities, 1)
