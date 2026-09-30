import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-12): `engine.ts` is harness-server's only door to the engine's SDK, so the
 * runner, the scheduler and the adaptive layer move to OpenCode 2 when that one class does.
 */
test("only engine.ts imports the SDK", () => {
  const root = import.meta.dir
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return walk(path)
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
  })(root)
  const importers = files
    .filter((file) => /from "@opencode-ai\/sdk/.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file))
  expect(importers).toEqual(["engine.ts"])
})
