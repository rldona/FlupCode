/**
 * The learned-skill lifecycle, as pure functions over the sidecar (FH-042, simplified by AH-F02).
 *
 * The signal is real use: a session that ran the engine's `skill` tool on the skill (the B01 session
 * metrics), counted once per distinct session when its episode closes. Nothing here reads a
 * `skillRelevance` suggestion, and there is no `since` window any more: the sidecar keeps when the
 * skill was last used, how many real sessions used it, and how many closed since the last use.
 *
 * ```
 * install or patch                          → probation, sessionsSinceUse = 0
 * a real session uses it                    → sessionsSinceUse = 0; probation/stale → mature
 * a real session closes without using it    → sessionsSinceUse + 1
 * sessionsSinceUse >= archiveAfter          → suggest archiving to a person (never automatic)
 * ```
 *
 * `stale` and `merged` are frozen: the harness never assigns them, and a sidecar that already carries
 * one is read as it is. Archiving is only ever a person's move from the Skills screen (AH-E04); the
 * lifecycle only says when to suggest it. A used skill resets its count, so it never proposes itself.
 */

import type { CountedSession, LedgerEvent, SkillSidecar, SkillState } from "./learned-store"
import { COUNTED_SESSIONS_KEEP } from "./learned-store"

export type LifecycleConfig = {
  /** Real sessions without a use after which archiving the skill is suggested to a person. */
  archiveAfter: number
}

/** A conservative default: a skill has to sit unused through twenty real sessions to be questioned. */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = { archiveAfter: 20 }

/** The part of the sidecar one real session moves. */
export type SkillUse = Pick<SkillSidecar, "state" | "usage" | "lastUsedAt" | "sessionsSinceUse" | "countedSessions">

/**
 * Folds one closed real session into a skill's use, with the ledger lines it earns; `undefined` when
 * the session was already counted as it is (a second close, a sweep racing the hook).
 *
 * A session closes once per episode, so it can be seen twice: unused at its first close and used at a
 * later one. The later use still counts and resets the unused count; a use is never counted twice.
 */
export function foldSession(
  current: SkillUse,
  session: { id: string; used: boolean; at: number },
): { next: SkillUse; events: LedgerEvent[] } | undefined {
  const counted = current.countedSessions ?? []
  const known = counted.find((entry) => entry.id === session.id)
  if (known && (known.used || !session.used)) return undefined
  const countedSessions: CountedSession[] = [
    ...counted.filter((entry) => entry.id !== session.id),
    { id: session.id, used: session.used },
  ].slice(-COUNTED_SESSIONS_KEEP)
  const opportunities = current.usage.opportunities + (known ? 0 : 1)

  if (!session.used)
    return {
      next: {
        ...current,
        usage: { ...current.usage, opportunities },
        sessionsSinceUse: current.sessionsSinceUse + 1,
        countedSessions,
      },
      events: [],
    }

  const usage = { ...current.usage, opportunities, load: current.usage.load + 1 }
  // A real use is the only thing that promotes; `stale` is frozen, so a legacy stale skill used again
  // leaves it rather than staying labelled as unused.
  const state: SkillState = current.state === "probation" || current.state === "stale" ? "mature" : current.state
  return {
    next: { ...current, state, usage, lastUsedAt: session.at, sessionsSinceUse: 0, countedSessions },
    events: [
      { at: session.at, event: "usage", kind: "load", total: usage.load },
      ...(state !== current.state
        ? [{ at: session.at, event: "state" as const, from: current.state, to: state, reason: "used" }]
        : []),
    ],
  }
}

/** Whether to suggest a person archive the skill: it sat unused through `archiveAfter` real sessions. */
export const suggestsArchive = (
  sidecar: Pick<SkillSidecar, "state" | "sessionsSinceUse">,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): boolean => sidecar.state !== "archived" && sidecar.state !== "merged" && sidecar.sessionsSinceUse >= config.archiveAfter
