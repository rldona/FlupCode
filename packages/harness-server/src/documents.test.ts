import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { discoverDocuments, documentType, registerDocuments } from "./documents"

const roots: string[] = []

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "flupcode-docs-"))
  roots.push(root)
  mkdirSync(join(root, ".flupcode", "artifacts"), { recursive: true })
  return root
}

const write = (root: string, name: string, content: string, binary = false) => {
  const path = join(root, ".flupcode", "artifacts", name)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, binary ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) : content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("documents the agent produced (H-14)", () => {
  test("only documents count, not the assets a page ships with", () => {
    expect(documentType("report.md")?.mime).toBe("text/markdown")
    expect(documentType("index.html")?.mime).toBe("text/html")
    expect(documentType("logo.svg")?.mime).toBe("image/svg+xml")
    expect(documentType("shot.PNG")?.mime).toBe("image/png")
    expect(documentType("app.js")).toBeUndefined()
    expect(documentType("style.css")).toBeUndefined()
  })

  test("reads a folder into documents, with a title and text kept inline", () => {
    const root = project()
    write(root, "report.md", "# Weekly review\n\nAll good.")
    write(root, "page.html", "<html><head><title>Landing</title></head><body>hi</body></html>")
    write(root, "shot.png", "", true)
    write(root, "app.js", "console.log(1)")

    const documents = discoverDocuments(root)
    // Only the three documents, not the script.
    expect(documents.map((doc) => doc.path).sort()).toEqual(
      [
        join(".flupcode", "artifacts", "page.html"),
        join(".flupcode", "artifacts", "report.md"),
        join(".flupcode", "artifacts", "shot.png"),
      ].sort(),
    )
    const report = documents.find((doc) => doc.path === join(".flupcode", "artifacts", "report.md"))!
    expect(report.title).toBe("Weekly review")
    expect(report.content).toContain("All good.")
    const page = documents.find((doc) => doc.path === join(".flupcode", "artifacts", "page.html"))!
    expect(page.title).toBe("Landing")
    // An image keeps its path and no words.
    const image = documents.find((doc) => doc.path === join(".flupcode", "artifacts", "shot.png"))!
    expect(image.mime).toBe("image/png")
    expect(image.content).toBeUndefined()
  })

  test("a document in a subfolder keeps its whole project-relative path", () => {
    const root = project()
    write(root, "nested/shot.png", "", true)

    const [document] = discoverDocuments(root)
    expect(document!.path).toBe(join(".flupcode", "artifacts", "nested", "shot.png"))
  })

  test("a documents folder that is a link out of the project is not read (TI-11)", () => {
    const outside = mkdtempSync(join(tmpdir(), "flupcode-docs-outside-"))
    roots.push(outside)
    writeFileSync(join(outside, "private.md"), "# Private\n")
    const root = mkdtempSync(join(tmpdir(), "flupcode-docs-"))
    roots.push(root)
    mkdirSync(join(root, ".flupcode"))
    symlinkSync(outside, join(root, ".flupcode", "artifacts"))
    expect(discoverDocuments(root)).toEqual([])
  })

  test("a missing folder is empty, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "flupcode-docs-"))
    roots.push(root)
    expect(discoverDocuments(root)).toEqual([])
  })

  test("registers once, and keeps a rewritten document as its next version, not a new row (RP-03)", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const root = project()
    write(root, "report.md", "# One")

    registerDocuments(repository, root)
    registerDocuments(repository, root)
    expect(repository.listArtifacts({ directory: root, kind: "document" })).toHaveLength(1)

    write(root, "report.md", "# Two")
    registerDocuments(repository, root)
    const kept = repository.listArtifacts({ directory: root, kind: "document" })
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ title: "Two", version: 2, versions: 2, producer: "agent" })
    expect(repository.listArtifactVersions(kept[0]!.id).map((version) => version.title)).toEqual(["Two", "One"])

    // Back to what an older version said is still the file's newest state, so it is a version too.
    write(root, "report.md", "# One")
    registerDocuments(repository, root)
    expect(repository.listArtifacts({ directory: root, kind: "document" })[0]).toMatchObject({ title: "One", version: 3 })
    repository.close()
  })
})
