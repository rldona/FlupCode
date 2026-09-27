import { describe, expect, test } from "bun:test"
import { normalizeRoutine } from "./routine-normalize"

const payload = (runs: unknown[]) => ({
  id: "routine_test",
  name: "Test routine",
  prompt: "Check the project",
  runs,
})

describe("normalizeRoutine run status", () => {
  test("keeps a running run running, with no error", () => {
    // A run the caller reports as running is in flight, not interrupted: the old whitelist turned it
    // into a failure and stamped it with the "Run interrupted" message.
    const routine = normalizeRoutine(payload([{ id: "run_1", startedAt: 1000, status: "running" }]))
    expect(routine?.runs[0]).toMatchObject({ id: "run_1", status: "running", error: undefined })
  })

  test("keeps an awaiting run awaiting", () => {
    const routine = normalizeRoutine(payload([{ id: "run_1", startedAt: 1000, status: "awaiting" }]))
    expect(routine?.runs[0]).toMatchObject({ id: "run_1", status: "awaiting", error: undefined })
  })

  test("still treats an unknown status as failed", () => {
    const routine = normalizeRoutine(payload([{ id: "run_1", startedAt: 1000, status: "vanished" }]))
    expect(routine?.runs[0]?.status).toBe("failed")
    expect(routine?.runs[0]?.error).toBeTruthy()
  })
})
