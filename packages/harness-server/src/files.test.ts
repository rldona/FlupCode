import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileError, MAX_BYTES, readProjectFile } from "./files"

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
})
