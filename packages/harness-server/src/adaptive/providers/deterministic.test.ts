/**
 * The failure deterministic baseline (FH-060/061, ADR-0023 §4–§6).
 *
 * The guarantee that holds with Jev off: a repeated identical call or error is an intervention at the
 * policy threshold.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_DECISION_POLICY } from "../decision"
import type { DecisionRequest } from "../decision"
import { deterministicBaseline } from "./deterministic"

const failure = (
  repeatedCalls: number,
  repeatedErrors: number,
  policy = DEFAULT_DECISION_POLICY,
): DecisionRequest<"failure"> => ({
  kind: "failure",
  state: { repeatedCalls, repeatedErrors, stepsUsed: 0 },
  policy,
})

describe("the failure baseline", () => {
  test("intervenes on a repeated identical call at the default threshold", () => {
    expect(deterministicBaseline(failure(3, 0))).toEqual({
      answer: { verdict: "intervene" },
      rule: "repeated-calls",
    })
  })

  test("intervenes on a repeated identical error", () => {
    expect(deterministicBaseline(failure(0, 3))).toEqual({
      answer: { verdict: "intervene" },
      rule: "repeated-errors",
    })
  })

  test("checks calls before errors when both cross the threshold", () => {
    expect(deterministicBaseline(failure(4, 4)).rule).toBe("repeated-calls")
  })

  test("continues below the threshold", () => {
    expect(deterministicBaseline(failure(2, 2))).toEqual({
      answer: { verdict: "continue" },
      rule: "safe-default",
    })
  })

  test("reads the thresholds from the request policy", () => {
    const policy = { ...DEFAULT_DECISION_POLICY, repeatedCalls: 2, repeatedErrors: 5 }
    expect(deterministicBaseline(failure(2, 2, policy)).rule).toBe("repeated-calls")
    const below = { ...DEFAULT_DECISION_POLICY, repeatedCalls: 9, repeatedErrors: 9 }
    expect(deterministicBaseline(failure(3, 3, below)).rule).toBe("safe-default")
  })
})
