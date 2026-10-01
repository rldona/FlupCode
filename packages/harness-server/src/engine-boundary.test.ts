import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-12, V2-26): `engine-v2.ts` is harness-server's only door to the engine, through
 * `@opencode/client`, so the runner, the scheduler and the adaptive layer follow a pin bump when that
 * one class does. Nothing reaches the 1.x SDK any more (ADR-0027).
 */
test("only engine-v2.ts imports OpenCode 2's client, and nothing the 1.x SDK", () => {
  const root = import.meta.dir
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return walk(path)
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
  })(root)
  const importers = (pattern: RegExp) =>
    files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(root, file))
  expect(importers(/from "@opencode-ai\//)).toEqual([])
  expect(importers(/from "@opencode\/client/)).toEqual(["engine-v2.ts"])
})
