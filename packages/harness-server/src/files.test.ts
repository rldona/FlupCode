import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileError, MAX_BYTES, readProjectFile } from "./files"
import { confinedPath, projectRoots } from "./project-roots"

let directory = ""

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-files-"))
  mkdirSync(join(directory, "src"), { recursive: true })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe("reading a file to look at it", () => {
  test("reads text inside the folder", () => {
    writeFileSync(join(directory, "src", "a.ts"), "export const a = 1\n")
    expect(readProjectFile({ directory, path: "src/a.ts" })).toEqual({
      path: "src/a.ts",
      content: "export const a = 1\n",
      bytes: 19,
      truncated: false,
      binary: false,
    })
  })

  test("caps what it returns and says it did", () => {
    writeFileSync(join(directory, "big.txt"), "x".repeat(100))
    const file = readProjectFile({ directory, path: "big.txt", maxBytes: 10 })
    expect(file.content).toBe("x".repeat(10))
    expect(file.bytes).toBe(100)
    expect(file.truncated).toBe(true)
  })

  test("a NUL byte means binary, and no content is returned as text", () => {
    writeFileSync(join(directory, "blob.bin"), Buffer.from([1, 0, 2, 3]))
    expect(readProjectFile({ directory, path: "blob.bin" })).toMatchObject({ binary: true, content: "" })
  })

  test("the cap is half a megabyte", () => {
    expect(MAX_BYTES).toBe(512 * 1024)
  })
})

describe("what it refuses", () => {
  test("a path outside the folder", () => {
    for (const path of ["../escape", "../../etc/hosts", "/etc/passwd"]) {
      expect(() => readProjectFile({ directory, path })).toThrow(FileError)
    }
  })

  test("a directory, and a file that is not there", () => {
    expect(() => readProjectFile({ directory, path: "src" })).toThrow(/not a file/)
    expect(() => readProjectFile({ directory, path: "src/missing.ts" })).toThrow(/No such file/)
  })

  test("a link inside the folder that points out of it (TI-11)", () => {
    const outside = mkdtempSync(join(tmpdir(), "flupcode-files-outside-"))
    writeFileSync(join(outside, "secret.txt"), "secret\n")
    symlinkSync(join(outside, "secret.txt"), join(directory, "leak.txt"))
    symlinkSync(outside, join(directory, "src", "elsewhere"))
    try {
      expect(() => readProjectFile({ directory, path: "leak.txt" })).toThrow(/outside the folder/)
      expect(() => readProjectFile({ directory, path: "src/elsewhere/secret.txt" })).toThrow(/outside the folder/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a link that stays inside the folder still reads", () => {
    writeFileSync(join(directory, "src", "a.ts"), "a\n")
    symlinkSync(join(directory, "src", "a.ts"), join(directory, "alias.ts"))
    expect(readProjectFile({ directory, path: "alias.ts" }).content).toBe("a\n")
  })
})

describe("which folders a caller may name (TI-11)", () => {
  test("a project, a folder inside it, and a worktree of it", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "flupcode-files-worktree-"))
    try {
      const roots = projectRoots(async () => [directory, worktree])
      expect(await roots.within(directory)).toBe(realpathSync(directory))
      expect(await roots.within(join(directory, "src"))).toBe(realpathSync(join(directory, "src")))
      expect(await roots.within(worktree)).toBe(realpathSync(worktree))
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  test("the filesystem root, even when the engine lists it", async () => {
    const roots = projectRoots(async () => ["/", directory])
    expect(await roots.within("/")).toBeUndefined()
    expect(await roots.within("/etc")).toBeUndefined()
    expect(await roots.within(directory)).toBe(realpathSync(directory))
  })

  test("a `..` out of a project, a sibling that shares its prefix, and a folder that is not there", async () => {
    const roots = projectRoots(async () => [join(directory, "src")])
    expect(await roots.within(join(directory, "src", ".."))).toBeUndefined()
    mkdirSync(join(directory, "src-other"))
    expect(await roots.within(join(directory, "src-other"))).toBeUndefined()
    expect(await roots.within(join(directory, "src", "missing"))).toBeUndefined()
  })

  test("a link to a project is the project, and a link out of one is not", async () => {
    const outside = mkdtempSync(join(tmpdir(), "flupcode-files-outside-"))
    symlinkSync(directory, join(outside, "alias"))
    symlinkSync(outside, join(directory, "out"))
    try {
      const roots = projectRoots(async () => [directory])
      expect(await roots.within(join(outside, "alias"))).toBe(realpathSync(directory))
      expect(await roots.within(join(directory, "out"))).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("an engine that cannot be asked knows no project, and one opened later is found", async () => {
    const listed: string[] = []
    let fail = true
    const roots = projectRoots(async () => {
      if (fail) throw new Error("engine down")
      return listed
    })
    expect(await roots.within(directory)).toBeUndefined()
    fail = false
    expect(await roots.within(directory)).toBeUndefined()
    listed.push(directory)
    expect(await roots.within(directory)).toBe(realpathSync(directory))
  })

  test("confinedPath resolves `..` and links before it answers", () => {
    expect(confinedPath(directory, "src/../src")).toBe(realpathSync(join(directory, "src")))
    expect(confinedPath(directory, "../x")).toBeUndefined()
    expect(confinedPath(directory, "/etc/hosts")).toBeUndefined()
  })
})
