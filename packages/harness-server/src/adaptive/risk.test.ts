/**
 * The raise-only risk algebra (FH-063, ADR-0023 §5).
 *
 * The invariant is a pure, exhaustive table: a learned score can only raise confirmation, never allow
 * or deny past the native floor. `deny` only ever survives because the native floor is already `deny`.
 */

import { describe, expect, test } from "bun:test"
import { LEARNED_CEILING, RISK_ORDER, clampLearned, elevateRisk } from "./risk"
import type { RiskLevel } from "./risk"

const rank = (risk: RiskLevel): number => RISK_ORDER.indexOf(risk)

describe("clampLearned", () => {
  test("caps every learned score at CONFIRM", () => {
    expect(clampLearned("ALLOW")).toBe("ALLOW")
    expect(clampLearned("CONFIRM")).toBe("CONFIRM")
    expect(clampLearned("REVIEW")).toBe(LEARNED_CEILING)
    expect(clampLearned("DENY")).toBe(LEARNED_CEILING)
  })
})

describe("elevateRisk", () => {
  /**
   * The exhaustive 4×4 table. Rows are the native floor, columns the learned score; the learned
   * column is clamped at `CONFIRM` before the maximum, which is what makes `DENY` reachable only from
   * a native `DENY`.
   */
  const table: Record<RiskLevel, Record<RiskLevel, RiskLevel>> = {
    ALLOW: { ALLOW: "ALLOW", CONFIRM: "CONFIRM", REVIEW: "CONFIRM", DENY: "CONFIRM" },
    CONFIRM: { ALLOW: "CONFIRM", CONFIRM: "CONFIRM", REVIEW: "CONFIRM", DENY: "CONFIRM" },
    REVIEW: { ALLOW: "REVIEW", CONFIRM: "REVIEW", REVIEW: "REVIEW", DENY: "REVIEW" },
    DENY: { ALLOW: "DENY", CONFIRM: "DENY", REVIEW: "DENY", DENY: "DENY" },
  }

  test("every native × learned pair follows the table", () => {
    for (const native of RISK_ORDER) {
      for (const learned of RISK_ORDER) {
        expect(elevateRisk(native, learned), `${native}×${learned}`).toBe(table[native][learned])
      }
    }
  })

  test("is monotone: the result is never less restrictive than the native floor", () => {
    for (const native of RISK_ORDER) {
      for (const learned of RISK_ORDER) {
        expect(rank(elevateRisk(native, learned)), `${native}×${learned}`).toBeGreaterThanOrEqual(rank(native))
      }
    }
  })

  test("never returns DENY unless the native floor is DENY", () => {
    for (const native of RISK_ORDER) {
      for (const learned of RISK_ORDER) {
        if (native !== "DENY") expect(elevateRisk(native, learned), `${native}×${learned}`).not.toBe("DENY")
      }
    }
  })
})
