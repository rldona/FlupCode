/**
 * The context fixtures: the FH-007 evidence, reduced to the items a plan is taken over (FH-021).
 *
 * Each fixture is a small, hand-labelled set: what must be kept (the objective, an error, a
 * referenced file), what is low-value payload (a tool call, a message, an older turn) and what is
 * left free. The scorer is expected to match the labels; if it does not, this file says so before
 * anything is ever applied. Every value is read literally — nothing is guessed.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isContextItemKind } from "./decision"
import type { ContextItem } from "./decision"
import { renderRunPrompt, runPromptParts } from "../runner"
import { planContextItems } from "./scoring"
import { DEFAULT_CONTEXT_BUDGET } from "./config"
import { DROPPABLE_CONTEXT_KINDS, PROTECTED_CONTEXT_KINDS } from "./decision"

const fixturesDirectory = join(import.meta.dir, "fixtures", "context")

type Label = "keep" | "drop"
type PromptFixture = {
  handoff?: string
  memory?: string
  artifacts?: string[]
  files?: string[]
  expected: string
}
type Fixture = {
  name: string
  objective: string
  now: number
  items: ContextItem[]
  labels: Record<string, Label>
  prompt?: PromptFixture
}

const files = readdirSync(fixturesDirectory).filter((name) => name.endsWith(".json")).sort()
const load = (name: string): Fixture => JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")) as Fixture

const fixtures = files.map((file) => ({ file, fixture: load(file) }))

const planFor = (fixture: Fixture) =>
  planContextItems({
    items: fixture.items,
    budget: DEFAULT_CONTEXT_BUDGET,
    now: fixture.now,
  })

describe("context fixtures (FH-021)", () => {
  test("there is at least one fixture", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const { file, fixture } of fixtures) {
    test(`${file}: the shape is complete and self-consistent`, () => {
      expect(fixture.name).toBe(file.replace(/\.json$/, ""))
      expect(typeof fixture.objective).toBe("string")
      expect(typeof fixture.now).toBe("number")
      expect(fixture.items.length).toBeGreaterThan(0)
      expect(fixture.items.every((item) => isContextItemKind(item.kind))).toBe(true)
      // Nothing reserved leaks in: `skill` is Phase 3b/4 and never a 3a item.
      expect(fixture.items.some((item) => item.kind === "skill")).toBe(false)
      const ids = new Set(fixture.items.map((item) => item.id))
      for (const [id, label] of Object.entries(fixture.labels)) {
        expect(ids.has(id)).toBe(true)
        expect(label === "keep" || label === "drop").toBe(true)
      }
    })
  }

  test("the scorer matches every hand-written label", () => {
    for (const { file, fixture } of fixtures) {
      const byID = Object.fromEntries(planFor(fixture).map((entry) => [entry.id, entry]))
      for (const [id, label] of Object.entries(fixture.labels)) {
        const entry = byID[id]!
        expect({ file, id, disposition: entry.disposition }).toEqual({ file, id, disposition: label })
      }
    }
  })

  test("protected kinds and droppable kinds are never confused", () => {
    for (const { fixture } of fixtures) {
      for (const entry of planFor(fixture)) {
        if (PROTECTED_CONTEXT_KINDS.includes(entry.kind)) expect(entry.disposition).toBe("keep")
        if (entry.disposition === "drop") expect(DROPPABLE_CONTEXT_KINDS).toContain(entry.kind)
      }
    }
  })

  test("the same input scores byte for byte the same", () => {
    for (const { fixture } of fixtures) {
      expect(planFor(fixture)).toEqual(planFor(fixture))
    }
  })

  test("a prompt fixture renders exactly its golden prompt, with its files", () => {
    for (const { file, fixture } of fixtures) {
      if (!fixture.prompt) continue
      const { expected, files: filePaths, ...rest } = fixture.prompt
      const { text, files: rendered } = renderRunPrompt(
        runPromptParts({
          objective: fixture.objective,
          ...rest,
          ...(filePaths ? { files: filePaths.map((path) => ({ path })) } : {}),
        }),
      )
      expect({ file, text }).toEqual({ file, text: expected })
      expect(rendered.map((entry) => entry.path)).toEqual(filePaths ?? [])
    }
  })
})
