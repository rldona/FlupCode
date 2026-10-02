import { describe, expect, test } from "bun:test"
import { runState, stateLabel, taskState } from "./run-state"
import type { Run, Task } from "./types"

const task = (over: Partial<Task>): Task => ({ id: "t", runID: "run", position: 0, name: "build", prompt: "", status: "success", ...over })
const run = (over: Partial<Run>): Run => ({ id: "run", source: { type: "manual" }, status: "success", startedAt: 0, ...over })
const failed = { value: "failed" as const, reason: "I cannot do this, so I stop here.", source: "rule" as const }

describe("where a task stands (UX-04)", () => {
  test("while it goes, its status", () => {
    expect(taskState(task({ status: "queued" }))).toBe("queued")
    expect(taskState(task({ status: "running" }))).toBe("running")
    expect(taskState(task({ status: "skipped" }))).toBe("skipped")
    expect(taskState(task({ status: "stopped" }))).toBe("stopped")
    expect(taskState(task({ status: "failed", verdict: failed }))).toBe("failed")
  })

  test("once its turn finished, its verdict, never 'success' beside it", () => {
    expect(taskState(task({ verdict: failed }))).toBe("failed")
    expect(taskState(task({ verdict: { value: "unverified", reason: "Nothing checked this answer", source: "rule" } }))).toBe("unverified")
    // Nothing judged an external command: it succeeded, and that is all that is said.
    expect(taskState(task({ kind: "external" }))).toBe("succeeded")
  })
})

describe("how a run stands, said once (UX-04)", () => {
  test("a finished run says its verdict, not its status", () => {
    expect(runState(run({ verdict: { ...failed, taskID: "t" } }))).toBe("failed")
    expect(runState(run({}))).toBe("succeeded")
  })

  test("a run that failed, stopped or waits says that", () => {
    expect(runState(run({ status: "failed", verdict: { value: "verified", reason: "ok", source: "check", taskID: "t" } }))).toBe("failed")
    expect(runState(run({ status: "stopped" }))).toBe("stopped")
    expect(runState(run({ status: "running" }))).toBe("running")
    expect(runState(run({ status: "awaiting", paused: "gate" }))).toBe("approval")
    expect(runState(run({ status: "awaiting", paused: "budget" }))).toBe("budget")
  })

  test("each state is one of the app's words", () => {
    expect(stateLabel("needs-user")).toBe("Needs your input")
    expect(stateLabel("approval")).toBe("Needs approval")
    expect(stateLabel("unverified")).toBe("Not verified")
  })
})
