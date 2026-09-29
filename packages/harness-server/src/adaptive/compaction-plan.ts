/**
 * The compaction plan and its recovery (FH-022, the pure part).
 *
 * A plan is the decision taken over the observed items: what stays in the prompt (`keep`), what is
 * set aside but recoverable (`archive`), and what low-value payload is dropped (`drop`) — each with
 * the stable reason that produced it and, when one exists, the evidence ref it can be explained
 * from. The plan holds opaque ids and scores, never content.
 *
 * Recovery never touches the prompt in flight: an archived item is re-admitted when the *next* plan
 * scores it, either because it was explicitly recovered (`recoverContextItems`) or because the scorer
 * awards the archived-but-referenced item its recovery bonus. An archived item is therefore always
 * reversible; a dropped payload's bytes still live in their durable source.
 */

import type { ContextItem } from "./decision"
import type { ContextScore } from "./scoring"
import type { ContextPlanEntry } from "../types"

/** The deterministic id of a plan, mirroring `decisionID`: re-planning converges on the row. */
export const planID = (scope: string): string => `plan:${scope}`

/**
 * An entry of the in-memory plan. It is the same shape the store keeps (`ContextPlanEntry`): the
 * plan's decision about one item, with its stable reason and, when the source has one, the evidence
 * ref it can be explained from.
 */
export type CompactionPlanEntry = ContextPlanEntry

export type CompactionPlan = {
  id: string
  keep: CompactionPlanEntry[]
  archive: CompactionPlanEntry[]
  drop: CompactionPlanEntry[]
  scoreSource: "deterministic" | "jev"
  degraded: boolean
  createdAt: number
}

export function compactionPlanFrom(input: {
  id: string
  scores: readonly ContextScore[]
  evidenceFor?: (id: string) => string | undefined
  scoreSource?: "deterministic" | "jev"
  degraded?: boolean
  createdAt: number
}): CompactionPlan {
  const entries: CompactionPlanEntry[] = input.scores.map((score) => {
    const evidenceRef = input.evidenceFor?.(score.id)
    return { ...score, ...(evidenceRef !== undefined ? { evidenceRef } : {}) }
  })
  return {
    id: input.id,
    keep: entries.filter((entry) => entry.disposition === "keep"),
    archive: entries.filter((entry) => entry.disposition === "archive"),
    drop: entries.filter((entry) => entry.disposition === "drop"),
    scoreSource: input.scoreSource ?? "deterministic",
    degraded: input.degraded ?? false,
    createdAt: input.createdAt,
  }
}

/** The archived ids a next turn may re-admit, in plan order. */
export function recoverableIDs(plan: CompactionPlan): string[] {
  return plan.archive.map((entry) => entry.id)
}

/** The archived ids a stored plan carries, so the next plan of the same scope can mark them. */
export function archivedIDs(entries: readonly ContextPlanEntry[]): string[] {
  return entries.filter((entry) => entry.disposition === "archive").map((entry) => entry.id)
}

/** Marks the given ids archived, so the next scoring sees them and can recover a referenced one. */
export function markArchivedItems(items: readonly ContextItem[], ids: readonly string[]): ContextItem[] {
  const archived = new Set(ids)
  return items.map((item) => (archived.has(item.id) ? { ...item, archived: true } : item))
}

/** Marks the plan's archived items so the next scoring sees them as archived (and can recover them). */
export function archiveContextItems(items: readonly ContextItem[], plan: CompactionPlan): ContextItem[] {
  return markArchivedItems(items, recoverableIDs(plan))
}

/** Clears the archived mark for the given ids, so the next plan re-admits them. */
export function recoverContextItems(items: readonly ContextItem[], ids: readonly string[]): ContextItem[] {
  const recovered = new Set(ids)
  return items.map((item) => (recovered.has(item.id) ? { ...item, archived: false } : item))
}
