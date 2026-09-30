import { describe, expect, test } from "bun:test"
import { guardrailAnnouncement, guardrailCause, guardrailFor } from "./GuardrailBanner"
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

describe("the guardrail announcement", () => {
  test("the live region reads the title and the cause as one sentence", () => {
    expect(guardrailAnnouncement(status({ tool: "bash" }))).toBe("Possible loop: 3 identical calls to bash in a row")
  })

  test("a loop without a tool still names something", () => {
    expect(guardrailAnnouncement(status())).toBe("Possible loop: 3 identical calls to a tool in a row")
  })
})

describe("which advisory the open session shows", () => {
  test("a reading for the open session is shown", () => {
    expect(guardrailFor({ sessionID: "ses_1", status: status() }, "ses_1")).toEqual(status())
  })

  test("a reading taken for another session is never shown", () => {
    // A slow answer for ses_1 that lands after switching to ses_2 must paint nothing there.
    expect(guardrailFor({ sessionID: "ses_1", status: status() }, "ses_2")).toBeUndefined()
  })

  test("nothing is shown without a reading or without an open session", () => {
    expect(guardrailFor(undefined, "ses_1")).toBeUndefined()
    expect(guardrailFor({ sessionID: "ses_1", status: status() }, undefined)).toBeUndefined()
  })

  test("a dismissed decision stays hidden, and a new decision shows again", () => {
    const reading = { sessionID: "ses_1", status: status() }
    expect(guardrailFor(reading, "ses_1", "failure:ses_1:bash:a")).toBeUndefined()
    expect(guardrailFor(reading, "ses_1", "failure:ses_1:bash:old")).toEqual(status())
  })
})
