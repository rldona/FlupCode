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

  test("keeps the verdict the server judged the run with, and drops one it cannot read", () => {
    const verdict = { value: "needs-user", reason: "Which parser?", source: "rule", taskID: "t1" }
    const routine = normalizeRoutine(
      payload([
        { id: "run_1", startedAt: 1000, status: "success", verdict },
        { id: "run_2", startedAt: 900, status: "success", verdict: { value: "great", taskID: "t1" } },
      ]),
    )
    expect(routine?.runs[0]?.verdict).toEqual(verdict as never)
    expect(routine?.runs[1]?.verdict).toBeUndefined()
  })
})

describe("normalizeRoutine schedule and status (RP-07)", () => {
  test("keeps the zone, the cron pattern and what the server says about when it runs and how it fails", () => {
    const routine = normalizeRoutine({
      ...payload([{ id: "run_2", startedAt: 2000, status: "failed", attempt: 2 }]),
      schedule: { type: "cron", expression: "30 9 * * 1-5", timezone: "Asia/Tokyo" },
      missed: "skip",
      retry: { count: 2, backoffMinutes: 10 },
      nextRunAt: 5000,
      failedInARow: 3,
      failing: true,
    })
    expect(routine).toMatchObject({
      schedule: { type: "cron", expression: "30 9 * * 1-5", timezone: "Asia/Tokyo" },
      missed: "skip",
      retry: { count: 2, backoffMinutes: 10 },
      nextRunAt: 5000,
      failedInARow: 3,
      failing: true,
    })
    expect(routine?.runs[0]?.attempt).toBe(2)
  })

  test("a routine from a server that says nothing of it has not failed and has no next run of its own", () => {
    const routine = normalizeRoutine({ ...payload([]), schedule: { type: "daily", time: "08:15" } })
    expect(routine).toMatchObject({ failedInARow: 0, failing: false })
    expect(routine?.nextRunAt).toBeUndefined()
  })
})
