/**
 * The context manager: plan a run prompt or an episode, persist the plan, and apply it (FH-022/023).
 *
 * The manager is the only place the deterministic scorer becomes a plan, the only place Jev refines
 * one, and the only place a plan filters parts. Planning is deterministic first: the scorer's plan is
 * the answer. Jev is asked only about items in the ambiguous band, one `contextItem` question that
 * carries just those items; with none ambiguous there is no call at all and no decision row. On any
 * degradation the deterministic baseline is kept, and on a total failure `plan` is `undefined`, so
 * the caller renders exactly what it would have rendered before selection existed.
 *
 * `apply` is pure and removes whole parts; with applying off, with no plan, or when planning failed,
 * it returns the parts untouched. The runner seam that calls it is FH-024.
 */

import type {
  ContextItem,
  DecisionRequest,
  DecisionSource,
  DegradedReason,
  ItemDisposition,
  PlanScoreSource,
} from "./decision"
import { DROPPABLE_CONTEXT_KINDS, PROTECTED_CONTEXT_KINDS } from "./decision"
import type { AdaptiveConfig } from "./config"
import { classifyEpisode, classifyRunPrompt } from "./context"
import type { ContextPart } from "./context"
import { archivedIDs, compactionPlanFrom, markArchivedItems, planID } from "./compaction-plan"
import type { CompactionPlan } from "./compaction-plan"
import { decisionID } from "./decision-record"
import { objectiveHash } from "./context-record"
import { applyContextBudget, isAmbiguous, planContextItems } from "./scoring"
import type { ContextScore } from "./scoring"
import type { DecisionService, DecisionExplanation, PredictionMode } from "./decision-service"
import type { EgressGuard } from "./egress"
import type {
  ContextPlanEntry,
  ContextPlanRepository,
  EpisodeRepository,
  PlanFilter,
  SessionEpisode,
  StoredPlan,
  StoredPlanInput,
} from "../types"

/** The repository the manager reads plans and episodes from, and writes plans to. */
export type ContextManagerRepository = ContextPlanRepository & Pick<EpisodeRepository, "getEpisode">

/** What a model refinement reports back; the manager merges it per item on top of the baseline. */
export type ContextRefinement = {
  dispositions: Record<string, ItemDisposition>
  source: DecisionSource
  /** The model that answered, when one did; it names the plan's refinement and each moved item. */
  provider?: string
  degraded: boolean
  degradedReason?: DegradedReason
  /** The `contextItem` decision row the attempt wrote, if it ran at all. */
  decisionID?: string
}

/** Everything a refinement needs, including the scope the decision id is built from. */
export type ContextRefinementInput = {
  objective: string
  items: readonly ContextItem[]
  ambiguous: readonly ContextScore[]
  baseline: readonly ContextScore[]
  scopeID: string
  runID?: string
  taskID?: string
  episodeID?: string
  sessionID?: string
  projectID?: string
  now: number
}

export type ContextPlanInput = {
  parts: readonly ContextPart[]
  objective: string
  runID: string
  taskID: string
  sessionID?: string
  projectID?: string
  now?: number
}

/** A plan explained from stored rows alone: its own entries, the episode's evidence and the decision. */
export type ContextPlanExplanation = StoredPlan & {
  evidenceRefs: string[]
  decision?: DecisionExplanation
}

export type ContextManager = {
  /** `undefined` when disabled, uncovered or on total failure: the caller does nothing. */
  plan(input: ContextPlanInput): Promise<CompactionPlan | undefined>
  /** Filters whole parts per the plan; identity when applying is off or the plan is missing. */
  apply(input: { parts: readonly ContextPart[]; plan: CompactionPlan | undefined }): ContextPart[]
  /** Marks a plan applied after it filtered something; an identity apply leaves the row false. */
  markApplied(id: string): void
  /** The retrospective plan of a closed episode (shadow); never throws. */
  planEpisode(episode: SessionEpisode, now?: number): Promise<CompactionPlan | undefined>
  listPlans(filter?: PlanFilter): StoredPlan[]
  explainPlan(id: string): ContextPlanExplanation | undefined
}

export type ContextManagerDeps = {
  config: () => AdaptiveConfig
  repository: ContextManagerRepository
  /** The Phase 2 decision service: the only way Jev is reached, with its egress gate and audit. */
  service: DecisionService
  /** The install's key for opaque episode ids; never exported or logged. */
  opaqueKey: () => Buffer
  /** The Phase 2 redaction, applied to the plan as it is written (ADR-0017 §3). */
  egress?: EgressGuard
  now?: () => number
  /** The classifier, injectable so a failure can be tested. */
  classify?: (input: { parts: readonly ContextPart[]; objective: string }) => ContextItem[]
  /** A refinement override; when absent the service is asked (the production path). */
  refine?: (input: ContextRefinementInput) => Promise<ContextRefinement | undefined>
}

/** A disposition that removes a part; anything else — including a corrupt value — normalises to keep. */
const isRemoval = (disposition: unknown): disposition is "archive" | "drop" =>
  disposition === "archive" || disposition === "drop"

/** The part kinds that are human instructions, never filtered whatever a plan says. */
const PROTECTED_PART_KINDS: ReadonlySet<ContextPart["kind"]> = new Set(["objective", "memory"])

/** A plan entry that names a protected kind, or that the plan itself marked protected. */
const isProtectedEntry = (entry: ContextPlanEntry): boolean =>
  entry.protected === true || PROTECTED_CONTEXT_KINDS.some((kind) => kind === entry.kind)

type Refined = {
  scores: ContextScore[]
  source: PlanScoreSource
  provider?: string
  degraded: boolean
  degradedReason?: DegradedReason
  decisionID?: string
}

export function createContextManager(deps: ContextManagerDeps): ContextManager {
  const now = deps.now ?? Date.now
  const classify = deps.classify ?? classifyRunPrompt

  /** Redacts the reason strings before they are written; entries carry no content otherwise. */
  const redactEntries = (entries: ContextPlanEntry[]): ContextPlanEntry[] => {
    const egress = deps.egress
    if (!egress) return entries
    return entries.map((entry) => ({ ...entry, reason: String(egress.redact(entry.reason)) }))
  }

  const persist = (input: {
    scopeID: string
    runID?: string
    taskID?: string
    episodeID?: string
    sessionID?: string
    projectID?: string
    objective: string
    refined: Refined
    at: number
  }): StoredPlan => {
    const entries = redactEntries(input.refined.scores.map((score) => ({ ...score })))
    const stored: StoredPlanInput = {
      id: planID(input.scopeID),
      ...(input.runID ? { runID: input.runID } : {}),
      ...(input.taskID ? { taskID: input.taskID } : {}),
      ...(input.episodeID ? { episodeID: input.episodeID } : {}),
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      ...(input.projectID ? { projectID: input.projectID } : {}),
      objectiveHash: objectiveHash(input.objective),
      entries,
      scoreSource: input.refined.source,
      ...(input.refined.provider ? { scoreProvider: input.refined.provider } : {}),
      degraded: input.refined.degraded,
      ...(input.refined.degradedReason ? { degradedReason: input.refined.degradedReason } : {}),
      // The manager never filters the prompt itself: applying is FH-024 and opt-in.
      applied: false,
      tokensBefore: input.refined.scores.reduce((total, score) => total + score.tokens, 0),
      tokensAfter: input.refined.scores
        .filter((score) => score.disposition === "keep")
        .reduce((total, score) => total + score.tokens, 0),
      ...(input.refined.decisionID ? { decisionID: input.refined.decisionID } : {}),
    }
    return deps.repository.createPlan(stored, input.at)
  }

  /** The production refinement: one `contextItem` question over only the ambiguous items. */
  const refineViaService = async (input: ContextRefinementInput, mode: PredictionMode): Promise<ContextRefinement> => {
    const config = deps.config()
    const ambiguous = new Set(input.ambiguous.map((entry) => entry.id))
    const request: DecisionRequest<"contextItem"> = {
      kind: "contextItem",
      state: { objective: input.objective, items: input.items.filter((item) => ambiguous.has(item.id)) },
      policy: config.decisions.contextItem,
      scopeID: input.scopeID,
      now: input.now,
      ...(input.episodeID ? { episodeID: input.episodeID } : {}),
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      ...(input.projectID ? { projectID: input.projectID } : {}),
    }
    const result = await deps.service.predict(request, mode)
    return {
      dispositions: Object.fromEntries(result.answer.decisions.map((entry) => [entry.id, entry.disposition])),
      source: result.source,
      provider: result.provider,
      degraded: result.degraded,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      // The service writes the row under the same id whenever it runs (it was asked).
      decisionID: decisionID("contextItem", input.scopeID),
    }
  }

  /**
   * The baseline, with the Jev refinement merged per item when the seam answers.
   *
   * Jev may only move an ambiguous item, and its answer is never trusted blindly: a `drop` on a kind
   * that is not a low-value payload is degraded to `archive` (ADR-0018 §3), and the merged plan is
   * run through the same budget cap as the planner, so an external `keep` can never push the plan
   * past `budget.total` or a per-class budget (ADR-0018 §3).
   */
  const refine = async (input: ContextRefinementInput, mode: PredictionMode): Promise<Refined> => {
    if (input.ambiguous.length === 0) return { scores: [...input.baseline], source: "baseline", degraded: false }
    const answer = deps.refine
      ? await deps.refine(input).catch(() => undefined)
      : await refineViaService(input, mode).catch(() => undefined)
    if (!answer) return { scores: [...input.baseline], source: "baseline", degraded: true }
    const ambiguous = new Set(input.ambiguous.map((entry) => entry.id))
    const merged = input.baseline.map((entry) => {
      if (answer.source !== "model" || !ambiguous.has(entry.id)) return entry
      const disposition = answer.dispositions[entry.id]
      if (disposition === undefined) return entry
      const safe: ItemDisposition =
        disposition === "drop" && !DROPPABLE_CONTEXT_KINDS.includes(entry.kind) ? "archive" : disposition
      // The reason names the model that moved the item, the way it always read "jev" for Jev.
      return { ...entry, disposition: safe, reason: answer.provider ?? "model" }
    })
    return {
      scores: applyContextBudget(merged, deps.config().context.budget),
      source: answer.source === "model" ? "model" : "baseline",
      ...(answer.source === "model" && answer.provider ? { provider: answer.provider } : {}),
      degraded: answer.degraded,
      ...(answer.degradedReason ? { degradedReason: answer.degradedReason } : {}),
      ...(answer.decisionID ? { decisionID: answer.decisionID } : {}),
    }
  }

  /**
   * The items with the ids the previous plan of the same scope archived marked, so the scorer can
   * award the recovery bonus to one the objective references again (FH-022 recovery). The prompt in
   * flight is never touched — recovery lands on the next plan.
   */
  const withArchived = (scopeID: string, items: ContextItem[]): ContextItem[] => {
    const previous = deps.repository.getPlan(planID(scopeID))
    return previous ? markArchivedItems(items, archivedIDs(previous.entries)) : items
  }

  const plan = async (input: ContextPlanInput): Promise<CompactionPlan | undefined> => {
    const config = deps.config()
    if (!config.enabled || !config.context.enabled) return undefined
    const at = input.now ?? now()
    const scopeID = `${input.runID}:${input.taskID}`
    try {
      const items = withArchived(scopeID, classify({ parts: input.parts, objective: input.objective }))
      const baseline = planContextItems({
        items,
        budget: config.context.budget,
        keepThreshold: config.context.keepThreshold,
        dropThreshold: config.context.dropThreshold,
        now: at,
      })
      const ambiguous = baseline.filter((entry) =>
        isAmbiguous(entry, config.context.keepThreshold, config.context.dropThreshold),
      )
      const refined = await refine({
        objective: input.objective,
        items,
        ambiguous,
        baseline,
        scopeID,
        runID: input.runID,
        taskID: input.taskID,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.projectID ? { projectID: input.projectID } : {}),
        now: at,
      }, "hot")
      persist({
        scopeID,
        runID: input.runID,
        taskID: input.taskID,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.projectID ? { projectID: input.projectID } : {}),
        objective: input.objective,
        refined,
        at,
      })
      return compactionPlanFrom({
        id: planID(scopeID),
        scores: refined.scores,
        scoreSource: refined.source,
        ...(refined.provider ? { scoreProvider: refined.provider } : {}),
        degraded: refined.degraded,
        createdAt: at,
      })
    } catch {
      // Anything that fails here is not worth a run: rendering the full prompt is always safe.
      return undefined
    }
  }

  const planEpisode = async (episode: SessionEpisode, at: number = now()): Promise<CompactionPlan | undefined> => {
    const config = deps.config()
    if (!config.enabled || !config.context.enabled) return undefined
    try {
      const items = withArchived(episode.id, classifyEpisode({ episode, key: deps.opaqueKey() }))
      const baseline = planContextItems({
        items,
        budget: config.context.budget,
        keepThreshold: config.context.keepThreshold,
        dropThreshold: config.context.dropThreshold,
        now: at,
      })
      const ambiguous = baseline.filter((entry) =>
        isAmbiguous(entry, config.context.keepThreshold, config.context.dropThreshold),
      )
      const refined = await refine({
        objective: episode.objective,
        items,
        ambiguous,
        baseline,
        scopeID: episode.id,
        episodeID: episode.id,
        sessionID: episode.sessionID,
        projectID: episode.projectID,
        now: at,
      }, "batch")
      persist({
        scopeID: episode.id,
        episodeID: episode.id,
        sessionID: episode.sessionID,
        projectID: episode.projectID,
        objective: episode.objective,
        refined,
        at,
      })
      return compactionPlanFrom({
        id: planID(episode.id),
        scores: refined.scores,
        scoreSource: refined.source,
        ...(refined.provider ? { scoreProvider: refined.provider } : {}),
        degraded: refined.degraded,
        createdAt: at,
      })
    } catch {
      return undefined
    }
  }

  const applies = (): boolean => {
    try {
      return deps.config().context.apply
    } catch {
      return false
    }
  }

  const apply = (input: { parts: readonly ContextPart[]; plan: CompactionPlan | undefined }): ContextPart[] => {
    if (!input.plan || !applies()) return [...input.parts]
    // Defence in depth: applying trusts the plan, but it never removes a protected kind — a human
    // instruction (`objective`, `memory`) is never archivable with `apply=true` (ADR-0018 §3) — and an
    // invalid disposition normalises to `keep` rather than filtering. A part the plan never saw is
    // kept: filtering only ever removes what the plan decided *and* this guard allows.
    const removable = new Set(
      [...input.plan.archive, ...input.plan.drop]
        .filter((entry) => isRemoval(entry.disposition) && !isProtectedEntry(entry))
        .map((entry) => entry.id),
    )
    return input.parts.filter((part) => !removable.has(part.id) || PROTECTED_PART_KINDS.has(part.kind))
  }

  /** Records that a plan actually filtered; the store is best-effort and never fails the run. */
  const markApplied = (id: string): void => {
    deps.repository.markApplied(id, now())
  }

  /**
   * Explains a plan from stored rows alone.
   *
   * Phase 3a has no per-item evidence ref to fill `ContextPlanEntry.evidenceRef` with — an opaque id
   * does not map to a run/task/session ref — so the durable evidence is reached at the plan level,
   * through the episode's `evidenceRefs`, exactly as Phase 2's `explain` does. The per-entry field is
   * left for the source that can supply it (Phase 3b/4).
   */
  const explainPlan = (id: string): ContextPlanExplanation | undefined => {
    const stored = deps.repository.getPlan(id)
    if (!stored) return undefined
    const episode = stored.episodeID ? deps.repository.getEpisode(stored.episodeID) : undefined
    const decision = stored.decisionID ? deps.service.explain(stored.decisionID) : undefined
    return {
      ...stored,
      evidenceRefs: episode?.evidenceRefs ?? [],
      ...(decision ? { decision } : {}),
    }
  }

  return { plan, apply, markApplied, planEpisode, listPlans: (filter) => deps.repository.listPlans(filter), explainPlan }
}
