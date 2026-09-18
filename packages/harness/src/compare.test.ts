import { describe, expect, test } from "bun:test"
import { compareRuns, formatDuration, runSnapshot } from "./compare"
import type { Run, Task, TouchedFiles } from "./types"

const run = (over: Partial<Run> = {}): Run => ({
  id: "run_a",
  source: { type: "manual" },
  status: "success",
  startedAt: 0,
  finishedAt: 60_000,
  ...over,
})

const task = (over: Partial<Task>): Task => ({
  id: over.id ?? over.name ?? "t",
  runID: "run_a",
  position: 0,
  name: "task",
  prompt: "",
  status: "success",
  ...over,
})

describe("summarising a run for comparison (H-33)", () => {
  test("adds up what the run spent and what its check said", () => {
    const snapshot = runSnapshot(
      run(),
      [
        task({ id: "t1", name: "build", tokens: 100, cost: 0.1 }),
        task({ id: "t2", name: "verify", kind: "verify", status: "failed", error: "Verification failed: test" }),
      ],
      [],
    )
    expect(snapshot).toMatchObject({
      status: "success",
      durationMs: 60_000,
      tokens: 100,
      cost: 0.1,
      tasks: { total: 2, success: 1, failed: 1, skipped: 0, running: 0, queued: 0 },
      verdict: { status: "failed", detail: "Verification failed: test" },
    })
  })

  test("counts a changed file once, however many tasks touched it", () => {
    const files: TouchedFiles[] = [
      { checkpointID: "c1", title: "one", files: [{ path: "src/a.ts", status: "modified" }] },
      { checkpointID: "c2", title: "two", files: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "added" }] },
    ]
    expect(runSnapshot(run(), [], files).files).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("a run with no check has no verdict, rather than a made-up one", () => {
    expect(runSnapshot(run(), [task({})], []).verdict).toBeUndefined()
  })

  // H-40: two executions of a workflow can also differ by what they were handed.
  test("keeps the context packs the run was given, and none when it had none", () => {
    expect(runSnapshot(run({ packs: ["ctx", "notes"] }), [], []).packs).toEqual(["ctx", "notes"])
    expect(runSnapshot(run(), [], []).packs).toBeUndefined()
  })
})

describe("comparing two runs", () => {
  const left = runSnapshot(run({ id: "run_a" }), [task({ tokens: 100, cost: 0.1 })], [])
  const right = runSnapshot(
    run({ id: "run_b", finishedAt: 30_000 }),
    [task({ tokens: 250, cost: 0.25 }), task({ id: "t2", status: "skipped" })],
    [],
  )

  test("puts both values on a row, and the difference between them", () => {
    const rows = compareRuns(left, right)
    const row = (label: string) => rows.find((entry) => entry.label === label)
    expect(row("Tokens")).toEqual({ label: "Tokens", a: "100", b: "250", delta: "+150" })
    expect(row("Cost")).toEqual({ label: "Cost", a: "$0.1000", b: "$0.2500", delta: "+$0.1500" })
    // A shorter run reads as a negative difference, which is the point of putting them side by side.
    expect(row("Duration")!.delta).toBe("−30s")
    expect(row("Tasks")!.b).toContain("1 skipped")
    expect(row("Verdict")).toEqual({ label: "Verdict", a: "—", b: "—" })
    // A list of names is a value, not something to subtract: "none" is what the other run was given.
    expect(row("Context packs")).toEqual({ label: "Context packs", a: "—", b: "—" })
  })

  test("reads a duration the way a person would", () => {
    expect(formatDuration(undefined)).toBe("—")
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(90_000)).toBe("1m 30s")
    expect(formatDuration(3_600_000)).toBe("1h 0m")
  })
})
