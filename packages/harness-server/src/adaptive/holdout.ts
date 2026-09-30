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

/**
 * The capabilities that act on a live session today; each is held out on its own. `toolTrim`,
 * `anchors` and `selection` joined with the preregistered promotion criteria (AH-G01, ADR-0025), so
 * every capability the live evaluation compares has a control arm.
 */
export const HOLDOUT_CAPABILITIES = ["relevance", "guardrails", "toolTrim", "anchors", "selection"] as const
export type HoldoutCapability = (typeof HOLDOUT_CAPABILITIES)[number]

export function armFor(sessionID: string, capability: HoldoutCapability, fraction: number): Arm {
  const bucket = createHash("sha256").update(`${capability}:${sessionID}`).digest().readUInt32BE(0) / 2 ** 32
  return bucket < fraction ? "control" : "treatment"
}

export function armsFor(sessionID: string, fraction: number): Record<HoldoutCapability, Arm> {
  // `fromEntries` forgets the keys; every capability is mapped, so the record is total.
  return Object.fromEntries(
    HOLDOUT_CAPABILITIES.map((capability) => [capability, armFor(sessionID, capability, fraction)]),
  ) as Record<HoldoutCapability, Arm>
}

export function isArm(value: unknown): value is Arm {
  return value === "control" || value === "treatment"
}
