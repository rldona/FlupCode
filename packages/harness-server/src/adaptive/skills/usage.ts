/**
 * Usage accounting for learned skills (FH-043, AH-F02).
 *
 * `load` is real use: a distinct session that ran the engine's `skill` tool on the skill, as the
 * session-metrics plugin (AH-B01) reports it, and `opportunities` the distinct real sessions closed
 * since install. A `skillRelevance` suggestion is never a load: what the harness guessed the model
 * should read is not what the model read. `view` counts only the harness re-reading a body to prepare
 * a patch (ADR-0019 §5), and `patch` a promotion that wrote a new version.
 */

import type { SessionMetricTurn } from "../session-metrics"
import type { SkillUsage } from "./learned-store"

/** One counter moved by one; the shape every harness re-read or write updates. */
export function bumpUsage(usage: SkillUsage, kind: "load" | "view" | "patch" | "opportunities"): SkillUsage {
  return { ...usage, [kind]: usage[kind] + 1 }
}

/**
 * The share of real sessions that used the skill, from install.
 *
 * `max(opportunities, 1)` keeps a skill that has never seen a session at rate 0 instead of a division
 * by zero, so "not yet measured" reads as 0 rather than as a crash or as undefined.
 */
export const recallRate = (usage: SkillUsage): number => usage.load / Math.max(usage.opportunities, 1)

/** The skills a session loaded through the engine's `skill` tool, from its metric turns, once each. */
export const sessionSkills = (turns: readonly Pick<SessionMetricTurn, "skills">[]): string[] => [
  ...new Set(turns.flatMap((turn) => turn.skills)),
]
