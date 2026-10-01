import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect } from "bun:test"

/**
 * Compares what a flow produced with the fixture recorded for it.
 *
 * Fixtures live in `fixtures/v2/<name>.json`, so a pin bump that changes the contract shows up as a
 * diff of that folder. A missing fixture is written, except in CI, where it fails: a contract nobody
 * recorded is not a contract. `UPDATE_FIXTURES=1` rewrites them all.
 */
export function matchFixture(kind: string, name: string, value: unknown) {
  const file = join(import.meta.dir, "..", "fixtures", kind, `${name}.json`)
  const update = process.env.UPDATE_FIXTURES === "1"
  if (!update && existsSync(file)) return expect(value).toEqual(JSON.parse(readFileSync(file, "utf8")))
  if (process.env.CI && !update) throw new Error(`No fixture recorded at ${file}; run with UPDATE_FIXTURES=1`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** The sorted keys of an object: the part of a response's shape a fixture can hold stably. */
export function keys(value: unknown) {
  return typeof value === "object" && value !== null ? Object.keys(value).sort() : []
}
