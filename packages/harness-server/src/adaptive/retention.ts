/**
 * The retention windows and what a purge deleted (ADR-0022 §2).
 *
 * This module is pure: it turns a `RetentionConfig` and a clock into the six cutoffs the SQL purge
 * compares `updated_at` against. The policy — the four tables, the per-state windows and the hard
 * exemptions — lives in `repository.purgeAdaptive`; here there is no database and no filesystem, so
 * a golden test can fix the arithmetic and the defaults can be reasoned about on their own.
 *
 * A cutoff is exclusive (`updated_at < cutoff`): a row touched exactly on its boundary is kept.
 */

import type { RetentionConfig } from "./config"

const DAY_MS = 24 * 60 * 60 * 1000

/** The six cutoffs, one per window, named for the column each is compared against. */
export type RetentionCutoffs = {
  decisionsBefore: number
  actingBefore: number
  plansBefore: number
  appliedPlansBefore: number
  reflectionBefore: number
  proposalsBefore: number
}

/** The cutoff a window implies, from a clock. Pure: no DB, no filesystem. */
export function retentionCutoffs(config: RetentionConfig, now: number): RetentionCutoffs {
  const before = (days: number): number => now - days * DAY_MS
  return {
    decisionsBefore: before(config.decisionsDays),
    actingBefore: before(config.actingDays),
    plansBefore: before(config.plansDays),
    appliedPlansBefore: before(config.appliedPlansDays),
    reflectionBefore: before(config.reflectionDays),
    proposalsBefore: before(config.rejectedProposalsDays),
  }
}

/** What one purge removed, per table and per acting/shadow split. */
export type RetentionPurge = {
  /** Shadow decisions removed (`shadow = 1`). */
  decisions: number
  /** Acting decisions removed (`shadow = 0`). */
  actingDecisions: number
  /** Plans removed, applied and shadowed together. */
  plans: number
  /** Terminal reflection jobs removed. */
  reflectionJobs: number
  /** Rejected, unreferenced proposals removed. */
  proposals: number
}
