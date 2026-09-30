/**
 * The per-session holdout (AH-B05).
 *
 * Each acting capability gets its own arm per session: `control` sessions are left alone — the
 * decision is still made and audited, it is only not applied — and `treatment` sessions get the
 * capability. Comparing the two is what turns "it seems to work" into a measurement (audit §14.2).
 *
 * The arm is a stable hash of the capability and the session id, so a session never changes arm
 * between turns or restarts, and the capabilities are assigned independently of each other.
 */

import { createHash } from "node:crypto"

export type Arm = "control" | "treatment"

/** The capabilities that act on a live session today; each is held out on its own. */
export const HOLDOUT_CAPABILITIES = ["relevance", "guardrails"] as const
export type HoldoutCapability = (typeof HOLDOUT_CAPABILITIES)[number]

export function armFor(sessionID: string, capability: HoldoutCapability, fraction: number): Arm {
  const bucket = createHash("sha256").update(`${capability}:${sessionID}`).digest().readUInt32BE(0) / 2 ** 32
  return bucket < fraction ? "control" : "treatment"
}

export function armsFor(sessionID: string, fraction: number): Record<HoldoutCapability, Arm> {
  return {
    relevance: armFor(sessionID, "relevance", fraction),
    guardrails: armFor(sessionID, "guardrails", fraction),
  }
}

export function isArm(value: unknown): value is Arm {
  return value === "control" || value === "treatment"
}
