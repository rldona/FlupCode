import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  test("a missing folder is empty, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "flupcode-docs-"))
    roots.push(root)
    expect(discoverDocuments(root)).toEqual([])
  })

  test("registers once, and keeps a rewritten document as a new snapshot", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const root = project()
    write(root, "report.md", "# One")

    registerDocuments(repository, root)
    registerDocuments(repository, root)
    expect(repository.listArtifacts({ directory: root, kind: "document" })).toHaveLength(1)

    write(root, "report.md", "# Two")
    registerDocuments(repository, root)
    const kept = repository.listArtifacts({ directory: root, kind: "document" })
    expect(kept).toHaveLength(2)
    expect(kept.map((artifact) => artifact.title).sort()).toEqual(["One", "Two"])
    expect(kept.every((artifact) => artifact.producer === "agent")).toBe(true)
    repository.close()
  })
})
