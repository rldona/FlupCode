/**
 * The per-project caps on what the learning loop may produce, and the freeze (AH-F03).
 *
 * Learning costs a classification and a draft per job and a person's attention per proposal, so the
 * loop is bounded per project: proposals per day, learned skills in total and patches per week. Every
 * window is rolling and ends now (the last 24 hours, the last 7 days), so a count never depends on
 * the time zone and a boundary is exact: a proposal created exactly one window ago no longer counts.
 *
 * A cap is checked twice by the manager. Before the classification, so a project at its cap spends
 * nothing; and again right before the proposal is written, after the last `await`, so reflections
 * that ran side by side cannot overshoot it together. Either way the job is `skipped` with a
 * `limit:<name>` reason, like every other gate skip. A cap never blocks a person: approving,
 * rejecting, disabling or archiving are not limited.
 *
 * The freeze is distinct from turning learning off: `learning.frozen` stops new jobs (reason
 * `frozen`) but keeps staged proposals reviewable, installed skills loading and the lifecycle ageing
 * them; `learning.enabled = false` stops all of that, approval included.
 */

import type { LearningConfig, LearningLimitsConfig } from "../config"
import { LEARNING_LIMIT_CEILINGS } from "../config"
import type { ReflectionIntent } from "../decision"
import type { LearningRepository, ReflectionRepository } from "../../types"

export const LEARNING_LIMITS = ["proposals-per-day", "learned-skills", "patches-per-week"] as const
export type LearningLimit = (typeof LEARNING_LIMITS)[number]

export const DAY_MS = 24 * 60 * 60_000
export const WEEK_MS = 7 * DAY_MS

/** The reason a job records when it was not started because learning is frozen. */
export const LEARNING_FROZEN_REASON = "frozen"

/** The reason a job records when a cap stopped it, e.g. `limit:proposals-per-day`. */
export const limitReason = (limit: LearningLimit) => `limit:${limit}`

/** One cap a project has reached: how much it used against the most it may. */
export type LearningLimitHit = { limit: LearningLimit; used: number; max: number }

/** A cap reached by one project, as the settings view reports it. */
export type ProjectLimitHit = LearningLimitHit & { projectID: string }

/**
 * How many proposals a count reads. Proposals are only written by the manager under the daily cap,
 * so a week holds at most seven days at its ceiling; the scan covers that and stays bounded.
 */
const PROPOSAL_SCAN_LIMIT = 7 * LEARNING_LIMIT_CEILINGS.proposalsPerDay + 1

/** The caps one project has reached right now, in `LEARNING_LIMITS` order; empty when none is. */
export function reachedLimits(input: {
  repository: Pick<LearningRepository, "listProposals">
  projectID: string
  /** The learned skills installed (loaded) for the project right now. */
  installedSkills: number
  limits: LearningLimitsConfig
  now: number
}): LearningLimitHit[] {
  const recent = input.repository.listProposals({ projectID: input.projectID, limit: PROPOSAL_SCAN_LIMIT })
  const within = (window: number) => recent.filter((proposal) => proposal.createdAt > input.now - window)
  // An `add` waiting for review is a skill a person can install with one click, so it holds a place.
  const pendingAdds = input.repository
    .listProposals({ projectID: input.projectID, status: "proposed", limit: LEARNING_LIMIT_CEILINGS.maxLearnedSkills })
    .filter((proposal) => proposal.intent === "add").length
  const usage: Record<LearningLimit, { used: number; max: number }> = {
    "proposals-per-day": { used: within(DAY_MS).length, max: input.limits.proposalsPerDay },
    "learned-skills": { used: input.installedSkills + pendingAdds, max: input.limits.maxLearnedSkills },
    "patches-per-week": {
      used: within(WEEK_MS).filter((proposal) => proposal.intent === "patch").length,
      max: input.limits.patchesPerWeek,
    },
  }
  return LEARNING_LIMITS.flatMap((limit) => (usage[limit].used >= usage[limit].max ? [{ limit, ...usage[limit] }] : []))
}

/**
 * The cap that stops a reflection, or undefined when it may go on.
 *
 * Without an intent (before the classification) it stops only when every outcome is capped: the
 * daily cap, or both the skill total (no `add`) and the weekly patches (no `patch`). With the intent,
 * the daily cap and that intent's own cap apply: a project full of skills can still improve them.
 */
export function blockingLimit(hits: readonly LearningLimitHit[], intent?: ReflectionIntent): LearningLimit | undefined {
  const reached = new Set(hits.map((hit) => hit.limit))
  if (reached.has("proposals-per-day")) return "proposals-per-day"
  if (intent === "add") return reached.has("learned-skills") ? "learned-skills" : undefined
  if (intent === "patch") return reached.has("patches-per-week") ? "patches-per-week" : undefined
  return reached.has("learned-skills") && reached.has("patches-per-week") ? "learned-skills" : undefined
}

/** How many recent jobs the settings view reads to find the projects learning is working on. */
const STATUS_JOB_SCAN = 50

/**
 * The caps reached by the projects learning touched lately, for the settings view: the projects of
 * the most recent reflection jobs, each counted live. Empty while learning is off.
 */
export function learningLimitStatus(input: {
  repository: Pick<LearningRepository, "listProposals"> & Pick<ReflectionRepository, "listReflectionJobs">
  installedSkills: (projectID: string) => number
  config: LearningConfig
  now: number
}): ProjectLimitHit[] {
  if (!input.config.enabled) return []
  const projects = [
    ...new Set(input.repository.listReflectionJobs({ limit: STATUS_JOB_SCAN }).flatMap((job) => (job.projectID ? [job.projectID] : []))),
  ]
  return projects.flatMap((projectID) =>
    reachedLimits({
      repository: input.repository,
      projectID,
      installedSkills: input.installedSkills(projectID),
      limits: input.config.limits,
      now: input.now,
    }).map((hit) => ({ projectID, ...hit })),
  )
}
