import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { packFiles, packRefs } from "./packs"
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
