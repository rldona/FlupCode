/**
 * The learned-skill lifecycle, as a pure function over usage and config (FH-042).
 *
 * `NEW` is not a state on disk: it is the proposal's state, and the curator installs straight into
 * `probation`. `merged` exists in the type but 3b never reaches it — merge is deferred (FH-044). So
 * the machine is a single step from the current state to the next, driven by the usage window:
 *
 * ```
 * install                                                 → probation
 * probation & opportunities >= probationSample & load/view → mature   (graduation)
 * probation & opportunities >= probationSample & no load   → stale
 * mature    & no load/view in the last staleAfter opportunities   → stale
 * stale     & no load/view after archiveAfter opportunities       → archived
 * patch (a new version)                                   → probation
 * ```
 *
 * Two rules from the plan are structural here rather than conditional. **PROBATION is not evictable**
 * — no edge leaves it for `archived`, so a new skill always gets its sample. **Only an unused skill
 * ages out** — `mature`/`stale` slide the window forward on any load or view, so a used skill can
 * never reach `archived` by age alone.
 *
 * The window is the part cumulative counters cannot express; `since` is the usage baseline the store
 * keeps beside the counters, advanced here whenever activity resets the clock.
 */

import type { SkillState, SkillUsage } from "./learned-store"
import { EMPTY_USAGE, usageDelta } from "./usage"

export type LifecycleConfig = {
  /** Opportunities a `probation` skill must have had before it is judged (fair sample). */
  probationSample: number
  /** Opportunities without a load or view after which a `mature` skill turns `stale`. */
  staleAfter: number
  /** Opportunities without a load or view after which a `stale` skill is archived. */
  archiveAfter: number
}

/** Conservative defaults; the numbers are configuration, the rules above are not. */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = { probationSample: 5, staleAfter: 10, archiveAfter: 20 }

export const LIFECYCLE_REASONS = ["patched", "graduated", "no-recall", "no-recent-use", "aged-out"] as const
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number]

export type LifecycleDecision =
  | { changed: true; from: SkillState; to: SkillState; reason: LifecycleReason; since: SkillUsage }
  | { changed: false; state: SkillState; since: SkillUsage }

export type LifecycleInput = {
  state: SkillState
  usage: SkillUsage
  /** Usage when the current window began; absent means "since creation". */
  since?: SkillUsage
  config?: Partial<LifecycleConfig>
  /** A patch just rewrote the skill; the design resets it to `probation` for re-evaluation. */
  patched?: boolean
}

/** One lifecycle step; the caller persists the new state and window when `changed` is true. */
export function nextSkillState(input: LifecycleInput): LifecycleDecision {
  const since = input.since ?? EMPTY_USAGE
  const config = { ...DEFAULT_LIFECYCLE_CONFIG, ...input.config }
  const state = input.state

  // Terminal states never move; `merged` is declared for FH-044 and deliberately unreachable here.
  if (state === "archived" || state === "merged") return { changed: false, state, since }
  if (input.patched) return { changed: true, from: state, to: "probation", reason: "patched", since: input.usage }

  const used = usageDelta(input.usage, since)

  if (state === "probation") {
    if (used.opportunities < config.probationSample) return { changed: false, state, since }
    // Graduation is by selection (`load`), the signal 3b measures; one never picked ages out.
    if (used.load > 0) return { changed: true, from: state, to: "mature", reason: "graduated", since: input.usage }
    return { changed: true, from: state, to: "stale", reason: "no-recall", since: input.usage }
  }

  if (state === "mature") {
    // Any load or view slides the window: a used skill is never archived by age alone.
    if (used.load > 0 || used.view > 0) return { changed: false, state, since: input.usage }
    if (used.opportunities >= config.staleAfter) {
      return { changed: true, from: state, to: "stale", reason: "no-recent-use", since: input.usage }
    }
    return { changed: false, state, since }
  }

  // `stale`: only a skill that stayed unused for `archiveAfter` opportunities is archived.
  if (used.load > 0 || used.view > 0) return { changed: false, state, since: input.usage }
  if (used.opportunities >= config.archiveAfter) {
    return { changed: true, from: state, to: "archived", reason: "aged-out", since: input.usage }
  }
  return { changed: false, state, since }
}
