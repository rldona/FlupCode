import { describe, expect, test } from "bun:test"
import { dayOf, summarise, type UsageRow } from "./usage"

const at = (day: number, hour = 12) => new Date(2026, 8, day, hour, 0, 0).getTime()

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  runID: "run_1",
  taskID: `task_${Math.random().toString(36).slice(2, 8)}`,
  name: "write",
  kind: "agent",
  agent: "build",
  model: { providerID: "anthropic", id: "opus" },
  attempt: 1,
  status: "success",
  startedAt: at(10),
  finishedAt: at(10) + 1000,
  tokens: 100,
  cost: 0.5,
  directory: "/work/app",
  ...over,
})

describe("summarise", () => {
  test("adds up what was spent, and counts the runs rather than the tasks", () => {
    const report = summarise([row(), row(), row({ runID: "run_2" })])
    expect(report.totals).toEqual({ runs: 2, tasks: 3, tokens: 300, cost: 1.5, ms: 3000 })
  })

  test("splits out what was paid for twice", () => {
    // A bounded retry is a new task, so the second attempt is a second bill. Mixed into the total
    // it is invisible; that is the number this whole thing exists to show.
    const report = summarise([row(), row({ attempt: 2, cost: 0.5, tokens: 100 })])

    expect(report.totals.cost).toBe(1)
    expect(report.retries).toEqual({ tasks: 1, tokens: 100, cost: 0.5 })
  })

  test("a verify task has no model, so it is not filed under one", () => {
    // It runs the project's own commands and no model at all. Filing it under a model would invent
    // a bill for one that was never called.
    const report = summarise([row({ kind: "verify", model: undefined, agent: undefined, cost: 0, tokens: 0 })])

    expect(report.byModel).toEqual([])
    expect(report.byAgent).toEqual([])
    expect(report.totals.tasks).toBe(1)
  })

  test("ranks by what it cost, biggest first", () => {
    const report = summarise([
      row({ model: { providerID: "a", id: "cheap" }, cost: 0.1 }),
      row({ model: { providerID: "a", id: "dear" }, cost: 2 }),
      row({ model: { providerID: "a", id: "middling" }, cost: 1 }),
    ])
    expect(report.byModel.map((entry) => entry.key)).toEqual(["a/dear", "a/middling", "a/cheap"])
  })

  test("ties are broken by name, so the order does not wobble between reads", () => {
    const report = summarise([
      row({ agent: "zebra", cost: 1, tokens: 10 }),
      row({ agent: "alpha", cost: 1, tokens: 10 }),
    ])
    expect(report.byAgent.map((entry) => entry.key)).toEqual(["alpha", "zebra"])
  })

  test("counts a project's runs, not just its tasks", () => {
    const report = summarise([
      row({ directory: "/work/app", runID: "r1" }),
      row({ directory: "/work/app", runID: "r1" }),
      row({ directory: "/work/app", runID: "r2" }),
      row({ directory: "/work/other", runID: "r3" }),
    ])
    const app = report.byProject.find((entry) => entry.key === "/work/app")
    expect(app).toMatchObject({ runs: 2, tasks: 3 })
  })

  test("leaves a task with no duration out of the time, and out of the slowest", () => {
    // Queued, or stopped before it began: counting either as zero-length work would be a lie about
    // how long things take.
    const report = summarise([
      row({ startedAt: undefined, finishedAt: undefined, status: "queued" }),
      row({ startedAt: at(10), finishedAt: undefined, status: "running" }),
      row({ startedAt: at(10), finishedAt: at(10) + 5000 }),
    ])
    expect(report.totals.ms).toBe(5000)
    expect(report.slowest).toHaveLength(1)
  })

  test("keeps the ten longest, longest first", () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      row({ name: `task ${index}`, startedAt: at(10), finishedAt: at(10) + index * 1000 }),
    )
    const report = summarise(rows)
    expect(report.slowest).toHaveLength(10)
    expect(report.slowest[0]!.name).toBe("task 14")
    expect(report.slowest[9]!.name).toBe("task 5")
  })

  test("the days come back in order, and only the days something happened", () => {
    const report = summarise([row({ startedAt: at(12) }), row({ startedAt: at(10) }), row({ startedAt: at(12, 20) })])
    expect(report.byDay.map((entry) => entry.day)).toEqual(["2026-09-10", "2026-09-12"])
    expect(report.byDay[1]!.cost).toBe(1)
  })

  test("nothing run, nothing claimed", () => {
    expect(summarise([])).toEqual({
      totals: { runs: 0, tasks: 0, tokens: 0, cost: 0, ms: 0 },
      retries: { tasks: 0, tokens: 0, cost: 0 },
      byModel: [],
      byAgent: [],
      byProject: [],
      byDay: [],
      slowest: [],
    })
  })
})

test("dayOf is the reader's own day, not UTC's", () => {
  // Eleven at night in Madrid is still the same day here; in UTC it might not be.
  const late = new Date(2026, 8, 12, 23, 30, 0).getTime()
  expect(dayOf(late)).toBe("2026-09-12")
})
