import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPlans, registerPlans } from "./plans"
import { SqliteRoutineRepository } from "./repository"

const directories: string[] = []
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-plans-"))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const plan = (directory: string, name: string, body: string) => {
  mkdirSync(join(directory, ".opencode", "plans"), { recursive: true })
  writeFileSync(join(directory, ".opencode", "plans", name), body)
}

describe("discoverPlans", () => {
  test("finds the markdown plans and titles them by their first heading", () => {
    const directory = scratch()
    plan(directory, "auth.md", "# Add authentication\n\nSteps.\n")
    plan(directory, "notes.txt", "not a plan\n")

    expect(discoverPlans(directory)).toEqual([
      { path: join(".opencode", "plans", "auth.md"), title: "Add authentication", content: "# Add authentication\n\nSteps.\n" },
    ])
  })

  test("falls back to the file name when there is no heading", () => {
    const directory = scratch()
    plan(directory, "rollout.md", "Just some lines, no heading.\n")
    expect(discoverPlans(directory)[0]!.title).toBe("rollout")
  })

  test("a project with no plans folder has no plans, rather than an error", () => {
    expect(discoverPlans(scratch())).toEqual([])
  })
})

describe("registerPlans", () => {
  test("indexes what was not indexed yet, and only once", () => {
    const directory = scratch()
    plan(directory, "auth.md", "# Auth\n")
    const repository = new SqliteRoutineRepository(":memory:")

    expect(registerPlans(repository, directory).map((artifact) => artifact.kind)).toEqual(["plan"])
    // Reading the same folder again adds nothing: the point is indexing, not duplicating.
    expect(registerPlans(repository, directory)).toEqual([])
    expect(repository.listArtifacts({ directory, kind: "plan" })).toHaveLength(1)
    expect(repository.listArtifacts({ directory, kind: "plan" })[0]!.path).toBe(
      join(".opencode", "plans", "auth.md"),
    )
    repository.close()
  })

  test("a plan that was rewritten is kept as a new snapshot", () => {
    const directory = scratch()
    plan(directory, "auth.md", "# Auth\n\nFirst take.\n")
    const repository = new SqliteRoutineRepository(":memory:")
    registerPlans(repository, directory)

    plan(directory, "auth.md", "# Auth\n\nSecond take, better.\n")
    registerPlans(repository, directory)

    expect(repository.listArtifacts({ directory, kind: "plan" })).toHaveLength(2)
    repository.close()
  })
})
