import { describe, expect, test } from "bun:test"
import { timelineLanes } from "./RunTimeline"
import type { Task } from "../types"

const task = (over: Partial<Task>): Task => ({
  id: over.id ?? over.name ?? "t",
  runID: "run",
  position: 0,
  name: "task",
  prompt: "",
  status: "success",
  ...over,
})

describe("placing a run on a timeline (H-28)", () => {
  test("tasks one after another share a lane", () => {
    const { lanes } = timelineLanes([
      task({ id: "a", name: "a", position: 0, startedAt: 0, finishedAt: 1000 }),
      task({ id: "b", name: "b", position: 1, startedAt: 1000, finishedAt: 2000 }),
    ])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.map((slot) => slot.task.name)).toEqual(["a", "b"])
  })

  test("tasks that overlapped are drawn on different rows", () => {
    const { lanes } = timelineLanes([
      task({ id: "a", name: "a", position: 0, startedAt: 0, finishedAt: 1000 }),
      // Started while `a` was still going: the whole point of seeing this.
      task({ id: "b", name: "b", position: 1, startedAt: 500, finishedAt: 1500 }),
      // And one that waits for the first lane to free up, so it is not given a third row.
      task({ id: "c", name: "c", position: 2, startedAt: 1000, finishedAt: 2000 }),
    ])
    expect(lanes.map((lane) => lane.map((slot) => slot.task.name))).toEqual([["a", "c"], ["b"]])
  })

  test("a task that never started is not drawn at the origin", () => {
    const { lanes, pending } = timelineLanes([
      task({ id: "a", name: "a", startedAt: 0, finishedAt: 1000 }),
      task({ id: "q", name: "queued", status: "queued" }),
      task({ id: "s", name: "skipped", status: "skipped" }),
    ])
    expect(lanes.flat().map((slot) => slot.task.name)).toEqual(["a"])
    expect(pending.map((entry) => entry.name)).toEqual(["queued", "skipped"])
  })

  test("a task still going is drawn to now", () => {
    const before = Date.now()
    const { lanes } = timelineLanes([task({ id: "running", name: "running", status: "running", startedAt: before })])
    expect(lanes[0]![0]!.end).toBeGreaterThanOrEqual(before)
  })
})
