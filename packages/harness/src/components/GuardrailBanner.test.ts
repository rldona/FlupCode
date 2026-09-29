import { describe, expect, test } from "bun:test"
import { guardrailCause } from "./GuardrailBanner"
import type { GuardrailStatus } from "../types"

const status = (over: Partial<GuardrailStatus> = {}): GuardrailStatus => ({
  reason: "loop",
  repeatedCalls: 3,
  repeatedErrors: 0,
  decisionID: "failure:ses_1:bash:a",
  at: 1,
  ...over,
})

describe("the guardrail cause", () => {
  test("a loop names the repeated calls", () => {
    expect(guardrailCause(status())).toBe("{count} identical calls to {tool} in a row")
  })

  test("an error names the repeated errors", () => {
    expect(guardrailCause(status({ reason: "error", repeatedCalls: 0, repeatedErrors: 4 }))).toBe(
      "{count} identical errors from {tool} in a row",
    )
  })
})
