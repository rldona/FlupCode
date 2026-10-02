import { expect, test } from "bun:test"
import { runInputs, runTitle } from "./run-title"
import type { Run } from "./types"

const run = (over: Partial<Run>): Run => ({
  id: "run_1",
  source: { type: "manual" },
  status: "success",
  startedAt: 0,
  ...over,
})
const feature = { name: "feature", scope: "project" as const, hash: "abc", inputs: { goal: "search", area: "api" } }

test("a run is named after the workflow it executed, whoever asked for it (RP-01)", () => {
  expect(runTitle(run({ workflow: feature }))).toBe("feature")
  expect(runTitle(run({ source: { type: "routine", routineID: "r1" }, workflow: feature }))).toBe("feature")
  expect(runTitle(run({}))).toBe("Manual run")
  expect(runTitle(run({ source: { type: "routine", routineID: "r1" } }))).toBe("Routine")
})

test("a routine's run is named after the routine when its name is known (UX-04)", () => {
  expect(runTitle(run({ source: { type: "routine", routineID: "r1" } }), "Nightly parser fix")).toBe("Nightly parser fix")
  // The workflow is still what it did.
  expect(runTitle(run({ source: { type: "routine", routineID: "r1" }, workflow: feature }), "Nightly")).toBe("feature")
})

test("a workflow run says the inputs it was given, and any other run none", () => {
  expect(runInputs(run({ workflow: feature }))).toBe("goal: search · area: api")
  expect(runInputs(run({ workflow: { ...feature, inputs: {} } }))).toBeUndefined()
  expect(runInputs(run({}))).toBeUndefined()
})
