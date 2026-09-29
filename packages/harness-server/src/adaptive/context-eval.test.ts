/**
 * The Phase 3a evaluation: a reproducible, offline before/after metric over the context fixtures.
 *
 * No network and no model: the same fixtures, the same fixed clock and the same exported thresholds
 * make every number below repeatable. There are four measurements, and they are what makes enabling
 * `apply` falsifiable (ADR-0018 §5):
 *
 *   1. retention — the objective and every error are kept, always (the trust invariant);
 *   2. reduction — the retained context costs fewer tokens than keeping everything;
 *   3. wrong rate — the scorer matches every hand-labelled disposition;
 *   4. byte-identity — with `apply=false` the prompt is exactly the one rendered without selection.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContextItem } from "./decision"
import { DEFAULT_CONTEXT_BUDGET, resolveAdaptiveConfig } from "./config"
import type { AdaptiveConfig } from "./config"
import { createContextManager } from "./context-manager"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { planContextItems } from "./scoring"
import type { ContextScore } from "./scoring"
import { renderRunPrompt, runPromptParts } from "../runner"
import { SqliteRoutineRepository } from "../repository"

const fixturesDirectory = join(import.meta.dir, "fixtures", "context")
const NOW = 1_700_000_000_000
const KEY = Buffer.alloc(32, 7)

type Label = "keep" | "drop"
type PromptFixture = { handoff?: string; memory?: string; artifacts?: string[]; files?: string[]; expected: string }
type Fixture = {
  name: string
  objective: string
  now: number
  items: ContextItem[]
  labels: Record<string, Label>
  prompt?: PromptFixture
}

const fixtures = readdirSync(fixturesDirectory)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(fixturesDirectory, file), "utf8")) as Fixture)

const planFor = (fixture: Fixture): ContextScore[] =>
  planContextItems({
    items: fixture.items,
    budget: DEFAULT_CONTEXT_BUDGET,
    now: fixture.now,
  })

const prompts = fixtures.filter((fixture): fixture is Fixture & { prompt: PromptFixture } => fixture.prompt !== undefined)

describe("context evaluation (FH-021…FH-024)", () => {
  test("1. the objective and every error are retained, in every fixture", () => {
    let protectedItems = 0
    for (const fixture of fixtures) {
      for (const entry of planFor(fixture)) {
        if (entry.kind !== "objective" && entry.kind !== "error") continue
        protectedItems += 1
        expect({ fixture: fixture.name, kind: entry.kind, disposition: entry.disposition }).toEqual({
          fixture: fixture.name,
          kind: entry.kind,
          disposition: "keep",
        })
      }
    }
    expect(protectedItems).toBeGreaterThan(0)
  })

  test("2. keeping the plan costs meaningfully fewer tokens than keeping everything", () => {
    let before = 0
    let after = 0
    for (const fixture of fixtures) {
      const plan = planFor(fixture)
      const kept = plan.filter((entry) => entry.disposition === "keep")
      const fixtureBefore = plan.reduce((total, entry) => total + entry.tokens, 0)
      const fixtureAfter = kept.reduce((total, entry) => total + entry.tokens, 0)
      expect(fixtureAfter).toBeLessThanOrEqual(fixtureBefore)
      before += fixtureBefore
      after += fixtureAfter
    }
    // Falsifiable: the aggregate must actually shrink, not merely not grow.
    expect(before).toBeGreaterThan(0)
    const reduction = 1 - after / before
    expect(reduction).toBeGreaterThan(0.5)
  })

  test("3. the scorer disposes of every labelled item as it was labelled", () => {
    let labelled = 0
    let wrong = 0
    for (const fixture of fixtures) {
      const byID = Object.fromEntries(planFor(fixture).map((entry) => [entry.id, entry]))
      for (const [id, label] of Object.entries(fixture.labels)) {
        labelled += 1
        if (byID[id]!.disposition !== label) wrong += 1
      }
    }
    expect(labelled).toBeGreaterThan(0)
    expect({ labelled, wrong, rate: wrong / labelled }).toEqual({ labelled, wrong: 0, rate: 0 })
  })

  test("4. with apply=false the prompt is byte-identical to the golden and to no selection", async () => {
    for (const fixture of prompts) {
      const { expected, files: filePaths, ...rest } = fixture.prompt
      const input = {
        objective: fixture.objective,
        ...rest,
        ...(filePaths ? { files: filePaths.map((path) => ({ path })) } : {}),
      }
      const parts = runPromptParts(input)
      expect(renderRunPrompt(parts).text).toBe(expected)

      const repository = new SqliteRoutineRepository(":memory:")
      const config = resolveAdaptiveConfig({ block: {}, env: {} })
      const manager = managerFor(repository, config)
      const plan = await manager.plan({
        parts,
        objective: fixture.objective,
        runID: "run-eval",
        taskID: fixture.name,
        now: NOW,
      })
      expect(plan).toBeDefined()
      // `apply` with applying off returns the very same parts: the renderer cannot see a difference.
      const active = manager.apply({ parts, plan })
      expect(active).toEqual(parts)
      expect(renderRunPrompt(active).text).toBe(expected)
      repository.close()
    }
  })

  test("4b. the kill switch plans nothing and the prompt is the golden", async () => {
    for (const fixture of prompts) {
      const { expected, files: filePaths, ...rest } = fixture.prompt
      const parts = runPromptParts({
        objective: fixture.objective,
        ...rest,
        ...(filePaths ? { files: filePaths.map((path) => ({ path })) } : {}),
      })
      const repository = new SqliteRoutineRepository(":memory:")
      const manager = managerFor(repository, resolveAdaptiveConfig({ block: { enabled: false }, env: {} }))
      expect(await manager.plan({ parts, objective: fixture.objective, runID: "run-eval", taskID: fixture.name })).toBeUndefined()
      expect(repository.listPlans()).toHaveLength(0)
      expect(renderRunPrompt(manager.apply({ parts, plan: undefined })).text).toBe(expected)
      repository.close()
    }
  })
})

const managerFor = (repository: SqliteRoutineRepository, config: AdaptiveConfig) => {
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const service = createDecisionService({ repository, config: () => config, egress, now: () => NOW })
  return createContextManager({
    repository,
    service,
    config: () => config,
    egress,
    opaqueKey: () => KEY,
    now: () => NOW,
  })
}
