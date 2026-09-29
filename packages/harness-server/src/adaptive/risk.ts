/**
 * The raise-only risk order (FH-063, ADR-0023 §5).
 *
 * A learned policy may only ever make a tool call more careful, never less: the engine's own
 * permission floor is the lower bound, and the learned score can raise confirmation but can never
 * allow, review or deny past that floor. This module is the pure algebra of that rule, so the
 * invariant is testable independently of any provider.
 */

export const RISK_ORDER = ["ALLOW", "CONFIRM", "REVIEW", "DENY"] as const
export type RiskLevel = (typeof RISK_ORDER)[number]

/** The most restrictive level a learned policy may reach, whatever the model scores. */
export const LEARNED_CEILING: RiskLevel = "CONFIRM"

const rank = (risk: RiskLevel): number => RISK_ORDER.indexOf(risk)

/** Caps a learned score at the ceiling; a native floor is never clamped by this. */
export const clampLearned = (risk: RiskLevel): RiskLevel => RISK_ORDER[Math.min(rank(risk), rank(LEARNED_CEILING))]!

/**
 * The most restrictive of the native floor and the **clamped** learned score.
 *
 * The learned input is clamped here as well as at the adapter, so the guarantee holds for every
 * caller: the result is never `DENY` unless the native floor already is.
 */
export const elevateRisk = (native: RiskLevel, learned: RiskLevel): RiskLevel => {
  const raised = Math.max(rank(native), rank(clampLearned(learned)))
  return RISK_ORDER[raised]!
}
