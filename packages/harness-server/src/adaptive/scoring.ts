/**
 * Deterministic context scoring and the class-and-budget planner (FH-021).
 *
 * The scorer is the baseline of the `contextItem` kind: it replaces Phase 2's keep-all, so with no
 * model the plan is exactly what this module computes. It is pure and total — no I/O, no clock beyond
 * the `now` it is handed, no model — and every weight, threshold and window is exported so
 * recalibrating never touches the algorithm and a golden test can fix the output.
 *
 * "Ambiguous" is the non-protected band strictly between the two thresholds: exactly the set a model may
 * be asked about (FH-023). Protected kinds are always kept; a low score only drops a low-value
 * payload, everything else is archived, and an archived item referenced by the objective can
 * recover.
 */

import type { ContextItem, ContextItemAnswer, ContextItemKind, ContextItemState, ItemDisposition } from "./decision"
import { DROPPABLE_CONTEXT_KINDS, PROTECTED_CONTEXT_KINDS } from "./decision"

/** The score is the weights applied to each signal; recalibration changes the numbers, not the code. */
export const CONTEXT_SCORE_WEIGHTS = {
  class: 0.45,
  recency: 0.2,
  anchor: 0.15,
  objective: 0.2,
  archivedPenalty: 0.3,
  recoveryBonus: 0.4,
} as const

/** The window over which recency fades; an item with no timestamp is treated as current. */
export const RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000
/** Anchors stop paying off after this many; `anchorSignal` is `min(anchors, cap) / cap`. */
export const ANCHOR_CAP = 4
/** At or above this the item is kept; below the drop threshold a payload may be dropped. */
export const KEEP_THRESHOLD = 0.6
export const DROP_THRESHOLD = 0.25

/** How much each class matters; `objective`/`error`/`other` are protected and never scored away. */
export const CONTEXT_CLASS_WEIGHT: Record<ContextItemKind, number> = {
  objective: 1,
  plan: 0.9,
  decision: 0.85,
  handoff: 0.85,
  file: 0.7,
  command: 0.6,
  error: 1,
  artifact: 0.6,
  memory: 0.7,
  tool: 0.1,
  message: 0.05,
  history: 0.05,
  skill: 0.6,
  other: 1,
}

/** The fill order: the objective first, evidence last, exactly plan §7.2. */
export const CONTEXT_CLASS_ORDER: readonly ContextItemKind[] = [
  "objective",
  "plan",
  "decision",
  "handoff",
  "file",
  "error",
  "artifact",
  "memory",
  "command",
  "tool",
  "message",
  "history",
  "skill",
  "other",
]

/** The token ceiling of a run prompt's context and how it is split class by class. */
export type ContextBudget = {
  total: number
  perClass: Record<ContextItemKind, number>
}

export type ContextScore = {
  id: string
  kind: ContextItemKind
  /** [0,1]. */
  score: number
  disposition: ItemDisposition
  /** A stable rule, in English. */
  reason: string
  protected: boolean
  tokens: number
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const isProtected = (kind: ContextItemKind): boolean => PROTECTED_CONTEXT_KINDS.includes(kind)
const isDroppable = (kind: ContextItemKind): boolean => DROPPABLE_CONTEXT_KINDS.includes(kind)

/** The most heavily weighted signal behind a keep, so the reason explains rather than labels. */
function keepReason(contributions: ReadonlyArray<readonly [string, number]>): string {
  return contributions.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
}

/**
 * One item's score and disposition, by the documented formula. Protected kinds short-circuit: the
 * score is still computed for explainability, but the disposition never leaves `keep`.
 */
function scoreItem(item: ContextItem, now: number, keepThreshold: number, dropThreshold: number): ContextScore {
  const classSignal = CONTEXT_CLASS_WEIGHT[item.kind]
  const recencySignal = item.createdAt === undefined ? 1 : clamp01(1 - (now - item.createdAt) / RECENCY_WINDOW_MS)
  const anchorSignal = Math.min(item.anchors, ANCHOR_CAP) / ANCHOR_CAP
  const objectiveSignal = item.referenced ? 1 : 0
  const archivedSignal = item.archived ? 1 : 0
  const score = clamp01(
    classSignal * CONTEXT_SCORE_WEIGHTS.class +
      recencySignal * CONTEXT_SCORE_WEIGHTS.recency +
      anchorSignal * CONTEXT_SCORE_WEIGHTS.anchor +
      objectiveSignal * CONTEXT_SCORE_WEIGHTS.objective -
      archivedSignal * CONTEXT_SCORE_WEIGHTS.archivedPenalty +
      (item.archived && item.referenced ? CONTEXT_SCORE_WEIGHTS.recoveryBonus : 0),
  )
  const base = { id: item.id, kind: item.kind, score, protected: isProtected(item.kind), tokens: item.tokens }

  if (base.protected) return { ...base, disposition: "keep", reason: "protected" }
  if (score >= keepThreshold)
    return {
      ...base,
      disposition: "keep",
      reason: keepReason([
        ["class-weight", classSignal * CONTEXT_SCORE_WEIGHTS.class],
        ["recency", recencySignal * CONTEXT_SCORE_WEIGHTS.recency],
        ["anchor", anchorSignal * CONTEXT_SCORE_WEIGHTS.anchor],
        ["objective-reference", objectiveSignal * CONTEXT_SCORE_WEIGHTS.objective],
      ]),
    }
  if (score <= dropThreshold && isDroppable(item.kind))
    return { ...base, disposition: "drop", reason: "low-value-payload" }
  return { ...base, disposition: "archive", reason: isAmbiguousScore(score, keepThreshold, dropThreshold) ? "ambiguous" : "mid-score" }
}

const isAmbiguousScore = (score: number, keepThreshold: number, dropThreshold: number): boolean =>
  score > dropThreshold && score < keepThreshold

/** Whether an entry is in the non-protected band a model may be asked about. */
export function isAmbiguous(
  entry: ContextScore,
  keepThreshold: number = KEEP_THRESHOLD,
  dropThreshold: number = DROP_THRESHOLD,
): boolean {
  return !entry.protected && isAmbiguousScore(entry.score, keepThreshold, dropThreshold)
}

/** The per-item score and disposition, before any budget is applied. */
export function scoreContextItems(input: {
  items: readonly ContextItem[]
  now: number
  keepThreshold?: number
  dropThreshold?: number
}): ContextScore[] {
  const keepThreshold = input.keepThreshold ?? KEEP_THRESHOLD
  const dropThreshold = input.dropThreshold ?? DROP_THRESHOLD
  return input.items.map((item) => scoreItem(item, input.now, keepThreshold, dropThreshold))
}

const classRank = (kind: ContextItemKind): number => CONTEXT_CLASS_ORDER.indexOf(kind)

/** Objective first, evidence last; within a class the higher score wins, then the smaller id. */
const compareForBudget = (a: ContextScore, b: ContextScore): number => {
  const byClass = classRank(a.kind) - classRank(b.kind)
  if (byClass !== 0) return byClass
  if (a.score !== b.score) return b.score - a.score
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The budget cap over already-scored entries: protected items consume their tokens first, drops and
 * archives free budget, and the remaining keeps are filled objective-first and by score; one that
 * does not fit is archived, never dropped. The returned entries keep the input order — the prompt is
 * filtered, not reordered.
 *
 * This is the one budget implementation, shared by the planner and by the manager when it re-applies
 * the cap after a model's refinement so an external `keep` can never exceed the ceiling.
 */
export function applyContextBudget(scores: readonly ContextScore[], budget: ContextBudget): ContextScore[] {
  const perClass: Record<ContextItemKind, number> = { ...budget.perClass }
  let total = budget.total
  const decided = new Map<string, ContextScore>()

  for (const entry of scores) {
    if (!entry.protected) continue
    perClass[entry.kind] -= entry.tokens
    total -= entry.tokens
    decided.set(entry.id, entry)
  }

  const candidates = scores.filter((entry) => !entry.protected && entry.disposition === "keep").sort(compareForBudget)
  for (const entry of candidates) {
    if (entry.tokens <= perClass[entry.kind] && entry.tokens <= total) {
      perClass[entry.kind] -= entry.tokens
      total -= entry.tokens
      decided.set(entry.id, entry)
    } else {
      decided.set(entry.id, { ...entry, disposition: "archive", reason: "budget-overflow" })
    }
  }

  return scores.map((entry) => decided.get(entry.id) ?? entry)
}

/**
 * The plan: protected items are kept and consume their tokens; drops free budget; the remaining
 * keeps are filled objective-first and by score, and one that does not fit is archived, never
 * dropped. The returned entries keep the input order — the prompt is filtered, not reordered.
 */
export function planContextItems(input: {
  items: readonly ContextItem[]
  budget: ContextBudget
  keepThreshold?: number
  dropThreshold?: number
  now: number
}): ContextScore[] {
  return applyContextBudget(scoreContextItems(input), input.budget)
}

/**
 * The deterministic baseline of the `contextItem` kind: the scorer, and nothing else.
 *
 * The service passes a state with no `now`, and the episode path builds items without a timestamp,
 * so this stays deterministic there; a caller that has timestamps passes `now` explicitly.
 */
export function deterministicContextItem(
  state: ContextItemState,
  now: number = Date.now(),
  keepThreshold?: number,
  dropThreshold?: number,
): ContextItemAnswer {
  return {
    decisions: scoreContextItems({ items: state.items, now, keepThreshold, dropThreshold }).map((entry) => ({
      id: entry.id,
      disposition: entry.disposition,
    })),
  }
}
