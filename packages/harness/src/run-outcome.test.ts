import { describe, expect, test } from "bun:test"
import { runOutcome } from "./run-outcome"

describe("runOutcome", () => {
  test("a failed execution keeps the engine's message", () => {
    expect(runOutcome("session.execution.failed", { error: { message: "Model not found" } })).toEqual({
      kind: "failed",
      message: "Model not found",
    })
  })

  test("a stop the reader did not ask for is told, with its reason", () => {
    expect(runOutcome("session.execution.interrupted", { reason: "shutdown" })).toEqual({
      kind: "interrupted",
      reason: "shutdown",
    })
    expect(runOutcome("session.execution.interrupted", { reason: "inactivity" })?.kind).toBe("interrupted")
  })

  test("the reader's own stop, a success and any other event say nothing", () => {
    expect(runOutcome("session.execution.interrupted", { reason: "user" })).toBeUndefined()
    expect(runOutcome("session.execution.succeeded", {})).toBeUndefined()
    expect(runOutcome("session.status", {})).toBeUndefined()
  })
})
