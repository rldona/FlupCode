import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-10, ADR-0027): OpenCode 2's generated client is imported by the adapter
 * (V2-20) and its event reducer (V2-21), and nowhere else, so a pin bump that changes it changes them
 * alone. Nothing imports the vendored upstream packages any more.
 */
const ALLOWED = new Set(["engine/v2.ts", "engine/v2-convert.ts", "engine/v2-events.ts"])

test("only the engine adapter imports OpenCode 2's client, and nothing an upstream workspace package", () => {
  const root = join(import.meta.dir, "..")
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return walk(path)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  })(root)
  const importers = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort()
  expect(importers(/from "@opencode-ai\//)).toEqual([])
  expect(importers(/from "@opencode\/client/)).toEqual([...ALLOWED].sort())
})
