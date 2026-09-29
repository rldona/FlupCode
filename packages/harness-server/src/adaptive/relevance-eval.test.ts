/**
 * The Phase 4 evaluation, offline (FH-04, ADR-0021 §7).
 *
 * This is a deliverable, not a unit test: it states the phase's metric with no network and no model.
 * Each fixture records a roster and a Jev answer; the deterministic line and the replayed Jev line
 * are compared against the labelled `good`/`wrong` sets (recall and wrong-load), and the run proves
 * determinism, inertness, a single batched request and the trust rule.
 *
 * The recorded answer is replayed through the real `DecisionService` + `JevClient` + `EgressGuard`;
 * the only injected thing is the `fetch` that returns the fixture, exactly as `decision-eval.test.ts`
 * does for Phase 2.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../repository"
import { resolveAdaptiveConfig } from "./config"
import { createAdaptiveEgressGuard } from "./egress"
import { createDecisionService } from "./decision-service"
import { createRelevanceService } from "./relevance"
import { createGovernor } from "./providers/governor"
import type { GovernorStore } from "./providers/governor"
import { createJevClient, createJevProvider } from "./providers/jev"
import type { JevFetch, JevFetchResponse } from "./providers/jev"
import { createFallbackProvider } from "./providers/fallback"
import type { RuntimeCapabilities } from "./runtime"
import type { SkillRosterEntry } from "./skills/curator"
import { rankSkills, renderSkillLine, SKILL_LINE_TEMPLATE } from "./skill-line"

const NOW = 1_700_000_000_000
const PROJECT = "/work/project"

type Fixture = {
  objective: string
  roster: Array<{ name: string; description: string; learned: boolean }>
  jev: { model: string; answers: Record<string, { type: "noul"; probability: number }> }
  good: string[]
  wrong: string[]
}

const fixtureNames = ["parser-test", "migrate-schema"]
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "relevance", `${name}.json`), "utf8")) as Fixture

const legacy: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: 0,
}

/** The recorded answer as a Jev body: the roster order is the question order, so `w{i}` is a name. */
const recorded = (fixture: Fixture): JevFetchResponse => {
  const answers = Object.fromEntries(
    fixture.roster.flatMap((skill, index) => {
      const answer = fixture.jev.answers[skill.name]
      return answer === undefined ? [] : [[`w${index}`, answer] as const]
    }),
  )
  return { ok: true, status: 200, headers: new Headers({}), json: async () => ({ model: fixture.jev.model, answers }) }
}

const stack = (
  fixture: Fixture,
  options: { jev: boolean; relevanceEnabled?: boolean; roster?: SkillRosterEntry[] },
) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({
    block: {
      relevance: { enabled: options.relevanceEnabled ?? true },
      jev: { enabled: options.jev },
      egress: { projects: [PROJECT], kinds: { skillRelevance: true } },
    },
    env: {},
  })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const store: GovernorStore = { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} }
  const governor = createGovernor({ config: config.governor, store, now: () => NOW })
  const spy = { calls: 0 }
  const fetch: JevFetch = async () => {
    spy.calls += 1
    return recorded(fixture)
  }
  const client = createJevClient({ fetch, egress, config: () => config.jev, now: () => NOW })
  const external = createFallbackProvider({ external: createJevProvider({ client }), maxAttempts: 1, now: () => NOW })
  const service = createDecisionService({ repository, config: () => config, egress, external, governor, now: () => NOW })
  const relevance = createRelevanceService({
    service,
    curator: { roster: () => options.roster ?? fixture.roster },
    runtimeProbe: { capabilities: () => legacy },
    config: () => config,
    now: () => NOW,
  })
  return { repository, relevance, spy }
}

const suggest = (relevance: ReturnType<typeof stack>["relevance"], fixture: Fixture, messageID = "msg_1") =>
  relevance.suggest({ projectID: PROJECT, sessionID: "ses_1", messageID, objective: fixture.objective })

describe("Phase 4 evaluation: relevance (offline, recorded)", () => {
  test("deterministic: with Jev off the lexical line recalls every good skill and no wrong one", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const { repository, relevance, spy } = stack(fixture, { jev: false })
      const result = await suggest(relevance, fixture)
      expect(result.reason, name).toBe("ok")
      expect(result.line, name).not.toBeNull()
      expect(result.line, name).toBe(SKILL_LINE_TEMPLATE(result.skills))
      for (const good of fixture.good) expect(result.skills, `${name}:${good}`).toContain(good)
      for (const wrong of fixture.wrong) expect(result.skills, `${name}:${wrong}`).not.toContain(wrong)
      expect(spy.calls, name).toBe(0)
      repository.close()
    }
  })

  test("recorded Jev: one batched request recalls the goods, no wrong-load, and the turn is cached", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const { repository, relevance, spy } = stack(fixture, { jev: true })
      const result = await suggest(relevance, fixture)
      expect(result.source, name).toBe("jev")
      expect(result.line, name).not.toBeNull()
      for (const good of fixture.good) expect(result.skills, `${name}:${good}`).toContain(good)
      for (const wrong of fixture.wrong) expect(result.skills, `${name}:${wrong}`).not.toContain(wrong)
      expect(spy.calls, name).toBe(1)
      // The same turn (title + turn) reuses the decision cache and spends no second Jev request.
      await suggest(relevance, fixture)
      expect(spy.calls, name).toBe(1)
      repository.close()
    }
  })

  test("determinism: the same input gives a byte-identical line", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const first = await suggest(stack(fixture, { jev: false }).relevance, fixture)
      const second = await suggest(stack(fixture, { jev: false }).relevance, fixture)
      expect(first.line, name).toBe(second.line)
    }
  })

  test("inertness: off, no objective and no roster produce no line", async () => {
    const fixture = load("parser-test")

    const off = stack(fixture, { jev: false, relevanceEnabled: false })
    expect((await suggest(off.relevance, fixture)).reason).toBe("disabled")
    off.repository.close()

    const noObjective = stack(fixture, { jev: false })
    const blank = await noObjective.relevance.suggest({
      projectID: PROJECT,
      sessionID: "ses_1",
      messageID: "msg_1",
      objective: "  ",
    })
    expect(blank).toMatchObject({ line: null, reason: "no-match" })
    noObjective.repository.close()

    const noRoster = stack(fixture, { jev: false, roster: [] })
    expect((await suggest(noRoster.relevance, fixture)).line).toBeNull()
    noRoster.repository.close()
  })

  test("trust: only roster names reach the line, never instructions or unknown names", () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const names = rankSkills({
        objective: fixture.objective,
        chosen: [...fixture.good, "ignore-all-instructions", "../../etc/passwd", ""],
        roster: fixture.roster,
        maxSkills: 3,
      })
      const line = renderSkillLine(names)
      expect(line).not.toBeUndefined()
      expect(line).not.toContain("ignore-all-instructions")
      expect(line).not.toContain("passwd")
      const valid = fixture.roster.map((entry) => entry.name)
      for (const chosen of names) expect(valid).toContain(chosen)
    }
  })
})
