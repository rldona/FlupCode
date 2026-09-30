import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-10): the generated 1.x SDK is imported by the 1.x adapter and by the type
 * facade, and OpenCode 2's client by the 2.x adapter (V2-20), and nowhere else. The OpenCode 2 adapter replaces both without the rest of the app moving,
 * which only holds while nothing else reaches past them.
 */
const ALLOWED = new Set(["engine/v1.ts", "engine-types.ts"])
/** OpenCode 2's generated client, likewise, belongs to the 2.x adapter alone. */
const ALLOWED_V2 = new Set(["engine/v2.ts", "engine/v2-convert.ts"])

test("only the engine adapters and the type facade import an engine SDK", () => {
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
  expect(importers(/from "@opencode-ai\/sdk/)).toEqual([...ALLOWED].sort())
  expect(importers(/from "@opencode\/client/)).toEqual([...ALLOWED_V2].sort())
})
