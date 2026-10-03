import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QUOTE_LIMIT, artifactQuote, packFiles, packRefs, expandArtifactRefs, resolveRefs } from "./packs"
import { SqliteRoutineRepository } from "./repository"
import type { ContextPack } from "./types"

let directory = ""

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-packrefs-"))
  mkdirSync(join(directory, "src"), { recursive: true })
  writeFileSync(join(directory, "src", "a.ts"), "export const a = 1\n")
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const pack = (name: string, refs: string[]): ContextPack => ({ id: name, name, refs, createdAt: 0 })

describe("the refs of the named packs", () => {
  test("only the named ones, in order, without repeats", () => {
    const packs = [pack("a", ["@x", "@y"]), pack("b", ["@y", "@z"])]
    expect(packRefs(packs, ["b", "a"])).toEqual(["@y", "@z", "@x"])
    expect(packRefs(packs, ["missing"])).toEqual([])
    expect(packRefs(packs, undefined)).toEqual([])
  })
})

describe("what a ref points at", () => {
  test("a file in the folder is a file part", () => {
    expect(packFiles(["@src/a.ts"], directory)).toEqual({ files: [join(directory, "src", "a.ts")], others: [] })
  })

  test("an artifact, an absolute path, a climb out and a path that is not there are all text", () => {
    const { files, others } = packFiles(
      ["@artifact:report", "/etc/passwd", "@../escape", "@src/missing.ts"],
      directory,
    )
    expect(files).toEqual([])
    expect(others).toEqual(["@artifact:report", "/etc/passwd", "@../escape", "@src/missing.ts"])
  })

  test("a folder is not read as a file", () => {
    expect(packFiles(["@src"], directory)).toEqual({ files: [], others: ["@src"] })
  })
})

describe("saying an artifact ref as its content (HF-6)", () => {
  const lookup = (key: string) =>
    key === "abc123"
      ? { title: "verify — passed", kind: "verdict", content: "Verification: passed" }
      : key === "verdict"
        ? { title: "verify — passed", kind: "verdict", content: "Verification: passed" }
        : key === "empty"
          ? { title: "empty", kind: "log" }
          : undefined

  test("an id resolves, a kind resolves, the rest stays literal", () => {
    expect(expandArtifactRefs(["@artifact:abc123"], lookup)).toEqual([
      "--- verify — passed (verdict) ---\n\nVerification: passed\n\n---",
    ])
    expect(expandArtifactRefs(["@artifact:verdict"], lookup)).toEqual([
      "--- verify — passed (verdict) ---\n\nVerification: passed\n\n---",
    ])
    expect(expandArtifactRefs(["@artifact:nope", "@src/a.ts", "@artifact:"], lookup)).toEqual([
      "@artifact:nope",
      "@src/a.ts",
      "@artifact:",
    ])
    expect(expandArtifactRefs(["@artifact:empty"], lookup)).toEqual(["@artifact:empty"])
  })
})

describe("a long artifact is cut, and says so (UX-05)", () => {
  test("past the limit the quote keeps the start and names what was dropped", () => {
    const long = "x".repeat(QUOTE_LIMIT + 10)
    const [quoted] = expandArtifactRefs(["@artifact:big"], () => ({ title: "Log", kind: "log", content: long }))
    expect(quoted).toContain(`[Cut: the first ${QUOTE_LIMIT} of ${QUOTE_LIMIT + 10} characters]`)
    expect(quoted!.length).toBeLessThan(QUOTE_LIMIT + 200)
  })
})

describe("what an artifact key names, for runs and chips alike", () => {
  test("an id, else the newest of a kind in the run, else in the folder; a document is read from disk", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    writeFileSync(join(directory, "notes.md"), "Notes on disk")
    const report = repository.addArtifact({ kind: "report", title: "R", producer: "harness", content: "In the row", directory })
    const document = repository.addArtifact({
      kind: "document",
      title: "Notes",
      producer: "agent",
      path: "notes.md",
      directory,
      mime: "text/markdown",
    })
    expect(artifactQuote(repository, report.id, {})).toEqual({ title: "R", kind: "report", content: "In the row" })
    expect(artifactQuote(repository, document.id, {})?.content).toBe("Notes on disk")
    expect(artifactQuote(repository, "report", { directory })?.content).toBe("In the row")
    expect(artifactQuote(repository, "report", {})).toBeUndefined()
    rmSync(join(directory, "notes.md"))
    expect(artifactQuote(repository, document.id, {})?.content).toBeUndefined()
    repository.close()
  })
})

describe("resolving the composer's refs (UX-05)", () => {
  test("files become file parts, artifacts quotes, and the rest is missing", () => {
    const lookup = (key: string) => (key === "r1" ? { title: "R", kind: "report", content: "Body" } : undefined)
    expect(resolveRefs(["@src/a.ts", "@artifact:r1", "@src/b.ts", "@artifact:r2"], directory, lookup)).toEqual([
      { ref: "@src/a.ts", uri: `file://${join(directory, "src", "a.ts")}`, name: "src/a.ts" },
      { ref: "@artifact:r1", quote: "--- R (report) ---\n\nBody\n\n---", cut: false },
      { ref: "@src/b.ts", missing: true },
      { ref: "@artifact:r2", missing: true },
    ])
    expect(resolveRefs(["@src/a.ts"], undefined, lookup)).toEqual([{ ref: "@src/a.ts", missing: true }])
  })
})
