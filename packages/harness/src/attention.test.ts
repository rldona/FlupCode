import { describe, expect, test } from "bun:test"
import { ATTENTION, runAttention, sessionAttention, tallyAttention, worstAttention } from "./attention"

const none = { approval: [], answer: [] }
const quiet = { approval: false, answer: false, running: false, failed: false, unseen: false }

describe("the attention scale", () => {
  test("is ordered approval > answer > failed > not verified > running > finished unseen", () => {
    expect([...ATTENTION]).toEqual(["approval", "answer", "failed", "unverified", "running", "unseen"])
    // Whatever order they come in, the most urgent wins.
    expect(worstAttention(["unseen", "running", "unverified", "failed", "answer", "approval"])).toBe("approval")
    expect(worstAttention(["running", "answer", undefined, false])).toBe("answer")
    expect(worstAttention(["running", "failed"])).toBe("failed")
    expect(worstAttention(["running", "unverified"])).toBe("unverified")
    expect(worstAttention(["unseen", "running"])).toBe("running")
    expect(worstAttention([undefined, false])).toBeUndefined()
  })

  test("a collapsed group says its most urgent level and how many rows are at it", () => {
    expect(tallyAttention(["running", "approval", undefined, "approval", "failed"])).toEqual({
      level: "approval",
      count: 2,
    })
    expect(tallyAttention([undefined, undefined])).toBeUndefined()
  })
})

describe("a session", () => {
  test("a permission outranks a question, and both outrank work going on", () => {
    expect(sessionAttention({ ...quiet, approval: true, answer: true, running: true })).toBe("approval")
    expect(sessionAttention({ ...quiet, answer: true, running: true })).toBe("answer")
    expect(sessionAttention({ ...quiet, running: true })).toBe("running")
  })

  test("how it ended counts only until it is seen", () => {
    expect(sessionAttention({ ...quiet, unseen: true, failed: true })).toBe("failed")
    expect(sessionAttention({ ...quiet, unseen: true })).toBe("unseen")
    expect(sessionAttention({ ...quiet, failed: true })).toBeUndefined()
    expect(sessionAttention(quiet)).toBeUndefined()
  })
})

describe("a run", () => {
  test("a gate is an approval even when nothing it ran was verified", () => {
    const run = { status: "awaiting" as const, verdict: { value: "unverified" as const } }
    expect(runAttention(run, none, false)).toBe("approval")
    expect(runAttention(run, none, true)).toBe("approval")
  })

  test("a task's session waiting on the reader is the run waiting on the reader", () => {
    const run = {
      status: "running" as const,
      sessionID: "ses_run",
      tasks: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }],
    }
    expect(runAttention(run, { approval: [], answer: ["ses_b"] }, true)).toBe("answer")
    expect(runAttention(run, { approval: ["ses_a"], answer: ["ses_b"] }, true)).toBe("approval")
    expect(runAttention(run, none, true)).toBe("running")
  })

  test("a finished run says how it ended, by its verdict, until it is seen", () => {
    const ended = (
      status: "success" | "failed" | "stopped",
      value?: "verified" | "unverified" | "needs-user" | "failed",
    ) => runAttention({ status, ...(value ? { verdict: { value } } : {}) }, none, false)
    expect(ended("success", "needs-user")).toBe("answer")
    expect(ended("success", "failed")).toBe("failed")
    expect(ended("failed")).toBe("failed")
    expect(ended("success", "unverified")).toBe("unverified")
    expect(ended("success", "verified")).toBe("unseen")
    expect(ended("stopped")).toBe("unseen")
    expect(runAttention({ status: "failed", verdict: { value: "failed" } }, none, true)).toBeUndefined()
  })
})
