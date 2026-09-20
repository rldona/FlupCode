import { describe, expect, test } from "bun:test"
import { ARTIFACT_LIMIT, SqliteRoutineRepository } from "./repository"

const open = () => new SqliteRoutineRepository(":memory:")

describe("what a run leaves behind", () => {
  test("is kept, and comes back newest first", () => {
    const repository = open()
    repository.addArtifact({ kind: "report", title: "older", producer: "harness", content: "a" }, 1000)
    repository.addArtifact({ kind: "verdict", title: "newer", producer: "harness", content: "b" }, 2000)

    expect(repository.listArtifacts().map((entry) => entry.title)).toEqual(["newer", "older"])
    repository.close()
  })

  test("is found by the project, the run, or what it is", () => {
    const repository = open()
    repository.addArtifact({ kind: "report", title: "mine", producer: "harness", content: "a", directory: "/work/a", runID: "r1" })
    repository.addArtifact({ kind: "verdict", title: "check", producer: "harness", content: "b", directory: "/work/a", runID: "r2" })
    repository.addArtifact({ kind: "report", title: "theirs", producer: "harness", content: "c", directory: "/work/b" })

    expect(repository.listArtifacts({ directory: "/work/a" }).map((e) => e.title).sort()).toEqual(["check", "mine"])
    expect(repository.listArtifacts({ runID: "r2" }).map((e) => e.title)).toEqual(["check"])
    expect(repository.listArtifacts({ kind: "report" }).map((e) => e.title).sort()).toEqual(["mine", "theirs"])
    // Filters narrow together rather than replacing each other.
    expect(repository.listArtifacts({ directory: "/work/a", kind: "report" }).map((e) => e.title)).toEqual(["mine"])
    repository.close()
  })

  test("text too long is cut, and says how long it was", () => {
    const repository = open()
    const huge = "x".repeat(ARTIFACT_LIMIT + 500)
    const artifact = repository.addArtifact({ kind: "log", title: "noisy", producer: "harness", content: huge })

    expect(artifact.content).toHaveLength(ARTIFACT_LIMIT)
    expect(artifact.truncated).toBe(true)
    // Refusing it would keep nothing; this keeps the first page and admits the rest is missing.
    expect(artifact.bytes).toBe(ARTIFACT_LIMIT + 500)
    expect(repository.getArtifact(artifact.id)?.truncated).toBe(true)
    repository.close()
  })

  test("the same text written twice is recognisable as the same thing", () => {
    const repository = open()
    const first = repository.addArtifact({ kind: "report", title: "a", producer: "harness", content: "same" })
    const second = repository.addArtifact({ kind: "report", title: "b", producer: "harness", content: "same" })
    const other = repository.addArtifact({ kind: "report", title: "c", producer: "harness", content: "different" })

    expect(first.hash).toBe(second.hash!)
    expect(other.hash).not.toBe(first.hash!)
    repository.close()
  })

  test("is on the stream, so a reader learns about it without asking", () => {
    const repository = open()
    const seen: string[] = []
    repository.subscribe((entry) => seen.push(entry.event.type))
    repository.addArtifact({ kind: "report", title: "a", producer: "harness", content: "x" })
    expect(seen).toEqual(["artifact.created"])
    repository.close()
  })

  test("can be forgotten, once", () => {
    const repository = open()
    const artifact = repository.addArtifact({ kind: "report", title: "a", producer: "harness", content: "x" })
    expect(repository.removeArtifact(artifact.id)).toBe(true)
    expect(repository.removeArtifact(artifact.id)).toBe(false)
    expect(repository.getArtifact(artifact.id)).toBeUndefined()
    repository.close()
  })
})
