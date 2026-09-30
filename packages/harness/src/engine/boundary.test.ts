import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-10): the generated 1.x SDK is imported by the 1.x adapter and by the type
 * facade, and nowhere else. The OpenCode 2 adapter replaces both without the rest of the app moving,
 * which only holds while nothing else reaches past them.
 */
const ALLOWED = new Set(["engine/v1.ts", "engine-types.ts"])

test("only the engine adapter and the type facade import the SDK", () => {
  const root = join(import.meta.dir, "..")
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return walk(path)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  })(root)
  const importers = files
    .filter((file) => /from "@opencode-ai\/sdk/.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file))
  expect(importers.sort()).toEqual([...ALLOWED].sort())
})
