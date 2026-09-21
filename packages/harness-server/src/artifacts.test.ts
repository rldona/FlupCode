import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { registerDocuments } from "./documents"
import { ARTIFACT_LIMIT, artifactHash, SqliteRoutineRepository } from "./repository"

const open = () => new SqliteRoutineRepository(":memory:")

const insertLegacyArtifact = (
  repository: SqliteRoutineRepository,
  id: string,
  path: string,
  kind = "document",
  directory = "/work/demo",
  hash?: string,
) =>
  repository.db
    .query(
      `INSERT INTO artifacts (id, kind, title, mime, producer, path, directory, hash, created_at)
       VALUES (?1, ?2, ?1, 'text/markdown', 'agent', ?3, ?4, ?5, 1000)`,
    )
    .run(id, kind, path, directory, hash ?? null)

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

  test("HF-7: is found by words in its title or content, including screenshots", () => {
    const repository = open()
    repository.addArtifact({ kind: "report", title: "Weekly review", producer: "harness", content: "nothing much" })
    repository.addArtifact({ kind: "verdict", title: "check", producer: "harness", content: "the review failed" })
    repository.addArtifact({ kind: "screenshot", title: "login page", producer: "user", content: "pixels", mime: "image/png" })

    expect(repository.listArtifacts({ q: "review" }).map((e) => e.title).sort()).toEqual(["Weekly review", "check"])
    expect(repository.listArtifacts({ q: "REVIEW" }).map((e) => e.title).sort()).toEqual(["Weekly review", "check"])
    expect(repository.listArtifacts({ q: "pixels", kind: "screenshot" }).map((e) => e.title)).toEqual(["login page"])
    // A LIKE wildcard in the query is text, not a pattern.
    expect(repository.listArtifacts({ q: "%" })).toEqual([])
    expect(repository.listArtifacts({ q: "  " })).toHaveLength(3)
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

  test("what was pinned stays in front, and is announced", () => {
    const repository = open()
    const older = repository.addArtifact({ kind: "report", title: "older", producer: "harness", content: "a" }, 1000)
    repository.addArtifact({ kind: "report", title: "newer", producer: "harness", content: "b" }, 2000)

    const seen: string[] = []
    repository.subscribe((entry) => seen.push(entry.event.type))
    const pinned = repository.setArtifactPinned(older.id, true)

    expect(pinned?.pinned).toBe(true)
    expect(seen).toEqual(["artifact.changed"])
    // Pinned first, even though it is older — that is the whole point of pinning.
    expect(repository.listArtifacts().map((entry) => entry.title)).toEqual(["older", "newer"])
    repository.close()
  })

  test("only what was told to expire is swept, and a pinned one never is", () => {
    const repository = open()
    const expiring = repository.addArtifact(
      { kind: "log", title: "expiring", producer: "harness", content: "a", expiresAt: 5000 },
      1000,
    )
    const kept = repository.addArtifact(
      { kind: "log", title: "pinned past its date", producer: "harness", content: "b", expiresAt: 5000 },
      1000,
    )
    repository.addArtifact({ kind: "report", title: "no date", producer: "harness", content: "c" }, 1000)
    repository.setArtifactPinned(kept.id, true)

    expect(repository.removeExpiredArtifacts(4000)).toBe(0)
    expect(repository.removeExpiredArtifacts(6000)).toBe(1)
    expect(repository.getArtifact(expiring.id)).toBeUndefined()
    expect(repository.getArtifact(kept.id)?.pinned).toBe(true)
    expect(repository.listArtifacts()).toHaveLength(2)
    repository.close()
  })

  test("retention can be cleared, and clearing it takes it out of the sweep", () => {
    const repository = open()
    const artifact = repository.addArtifact(
      { kind: "log", title: "a", producer: "harness", content: "a", expiresAt: 5000 },
      1000,
    )
    expect(repository.setArtifactRetention(artifact.id, undefined)?.expiresAt).toBeUndefined()
    expect(repository.removeExpiredArtifacts(6000)).toBe(0)
    expect(repository.getArtifact(artifact.id)).toBeDefined()
    repository.close()
  })
})

describe("documents indexed before the path convention was fixed", () => {
  const directories: string[] = []
  const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-artifacts-"))
    directories.push(directory)
    return join(directory, "harness.sqlite")
  }
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test("lifts legacy document paths to project-relative, leaves the rest alone, and is idempotent", () => {
    const path = scratch()
    const before = new SqliteRoutineRepository(path)
    insertLegacyArtifact(before, "d1", "report.md")
    insertLegacyArtifact(before, "d2", join("sub", "report.md"))
    insertLegacyArtifact(before, "d3", join(".flupcode", "artifacts", "report.md"))
    insertLegacyArtifact(before, "d4", "/work/demo/notes.md")
    insertLegacyArtifact(before, "d5", "report.md", "plan")
    insertLegacyArtifact(before, "d6", "report.md", "report")
    // An API-made row can already be project-relative with forward slashes on any platform.
    insertLegacyArtifact(before, "d7", ".flupcode/artifacts/report.md")
    before.close()

    const after = new SqliteRoutineRepository(path)
    expect(after.getArtifact("d1")?.path).toBe(join(".flupcode", "artifacts", "report.md"))
    expect(after.getArtifact("d2")?.path).toBe(join(".flupcode", "artifacts", "sub", "report.md"))
    // Already project-relative, absolute, or not a document: untouched.
    expect(after.getArtifact("d3")?.path).toBe(join(".flupcode", "artifacts", "report.md"))
    expect(after.getArtifact("d4")?.path).toBe("/work/demo/notes.md")
    expect(after.getArtifact("d5")?.path).toBe("report.md")
    expect(after.getArtifact("d6")?.path).toBe("report.md")
    expect(after.getArtifact("d7")?.path).toBe(".flupcode/artifacts/report.md")
    after.close()

    const again = new SqliteRoutineRepository(path)
    expect(again.getArtifact("d1")?.path).toBe(join(".flupcode", "artifacts", "report.md"))
    expect(again.getArtifact("d3")?.path).toBe(join(".flupcode", "artifacts", "report.md"))
    expect(again.getArtifact("d7")?.path).toBe(".flupcode/artifacts/report.md")
    again.close()
  })

  test("a repaired document is not indexed a second time", () => {
    const path = scratch()
    const project = dirname(path)
    const content = "# One\n\nbody"
    mkdirSync(join(project, ".flupcode", "artifacts"), { recursive: true })
    writeFileSync(join(project, ".flupcode", "artifacts", "report.md"), content)

    const before = new SqliteRoutineRepository(path)
    insertLegacyArtifact(before, "doc1", "report.md", "document", project, artifactHash(content))
    before.close()

    const after = new SqliteRoutineRepository(path)
    registerDocuments(after, project)
    expect(after.listArtifacts({ directory: project, kind: "document" })).toHaveLength(1)
    after.close()
  })
})
