/**
 * The Phase 4 / PoC-3 evaluation, offline (FH-04, ADR-0021 §7, ADR-0022 §6).
 *
 * This is a deliverable, not a unit test. It states the acting line's metric with **no network and no
 * model**, over a curated, labelled set of real repository objectives
 * (`fixtures/relevance/*.json`, ~20 technical English objectives). Each fixture records a roster, a
 * Jev answer, the human `good`/`wrong` judgement and simulated timing/cost metadata.
 *
 * What is measured: recall@3, wrong-load, precision and the degradation rate, for the deterministic
 * lexical baseline against the recorded Jev answer, plus the server-path latency, the production
 * `estimateTokens(body)` cost and its projected monthly volume. `PROMOTION_THRESHOLD` fixes the
 * offline gate and this file asserts it.
 *
 * What is **simulated**, never measured: the recorded Jev answer itself, `degraded`,
 * `simulatedLatencyMs` and `simulatedTokens`. The live PoC — real Jev, real engine with the plugin,
 * measured latency/cost and a human-labelled sample — is blocked on `TYPESAFE_API_KEY` and
 * environment and is documented as such (ADR-0022 §6). This set calibrates the pipeline, not the
 * model.
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
import { createJevClient, createJevModel } from "./providers/jev"
import type { JevFetch, JevFetchResponse } from "./providers/jev"
import { createRetryingModel } from "./providers/retry"
import type { RuntimeCapabilities } from "./runtime"
import type { SkillRosterEntry } from "./skills/curator"
import { rankSkills, renderSkillLine, SKILL_LINE_TEMPLATE } from "./skill-line"

const NOW = 1_700_000_000_000
const PROJECT = "/work/project"

/**
 * The offline promotion gate (ADR-0022 §6, `fh-promotion-design.md` decision 6). The gate applies to
 * the promoted path — the recorded Jev line, with the lexical fallback on a degraded turn — and the
 * baseline is reported beside it. `wrongLoad` is the acceptance metric: zero on every fixture.
 */
export const PROMOTION_THRESHOLD = {
  recallAt3: 0.8,
  precision: 0.6,
  wrongLoad: 0,
} as const

/** The hot path's own deadline; recorded timing metadata may not exceed it. */
const HOT_LATENCY_CEILING_MS = 400

/**
 * The per-project monthly volume the cost projection assumes. This is an assumption, not a
 * measurement; the offline set cannot know the real call rate (the live PoC would).
 */
const ASSUMED_RELEVANCE_CALLS_PER_MONTH = 200

type Fixture = {
  objective: string
  roster: Array<{ name: string; description: string; learned: boolean }>
  jev: { model: string; answers: Record<string, { type: "noul"; probability: number }> }
  /** The names that should load; `wrong` are the names that must not. Neither list is exhaustive. */
  good: string[]
  wrong: string[]
  /** Recorded: this fixture simulates a Jev timeout/error, so the line is the lexical fallback. */
  degraded: boolean
  /** Recorded, never measured: the Jev round-trip latency this fixture stands in for. */
  simulatedLatencyMs: number
  /** Recorded, never measured: the tokens this fixture's Jev answer stands in for. */
  simulatedTokens: number
}

const fixtureNames = [
  "parser-test",
  "migrate-schema",
  "refactor-auth",
  "add-unit-tests",
  "security-xss",
  "perf-slow-query",
  "ci-flaky-build",
  "incident-rollback",
  "dependency-upgrade",
  "api-version",
  "concurrency-race",
  "observability-metrics",
  "docs-readme",
  "i18n-locale",
  "accessibility-focus",
  "data-pipeline",
  "auth-session",
  "memory-leak",
  "release-changelog",
  "code-review",
] as const

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

/** A recorded Jev failure: the fallback records `timeout` and the lexical line is what runs. */
const recordedTimeout = (): Error => {
  const error = new Error("recorded timeout")
  error.name = "TimeoutError"
  return error
}

type Usage = { tokens: number; calls: number }

const stack = (
  fixture: Fixture,
  options: { jev: boolean; relevanceEnabled?: boolean; roster?: SkillRosterEntry[]; clock?: () => number },
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
  // The governor's reservation *is* `estimateTokens(body) × calls`; the store keeps both numbers so
  // the metric reads the production estimate, not a second one invented by the test.
  const spent: Usage = { tokens: 0, calls: 0 }
  const store: GovernorStore = {
    adaptiveUsage: () => ({ ...spent }),
    addAdaptiveUsage: (_month, tokens, calls) => {
      spent.tokens += tokens
      spent.calls += calls
    },
  }
  const governor = createGovernor({ config: () => config.governor, store, now: () => NOW })
  const spy = { calls: 0 }
  const fetch: JevFetch = async () => {
    spy.calls += 1
    if (fixture.degraded) throw recordedTimeout()
    return recorded(fixture)
  }
  const client = createJevClient({ fetch, egress, config: () => config.jev, now: () => NOW })
  const jev = createRetryingModel({ model: createJevModel({ client, now: () => NOW }), maxAttempts: 1 })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    models: [jev],
    governor,
    now: () => NOW,
  })
  const relevance = createRelevanceService({
    service,
    curator: { roster: () => options.roster ?? fixture.roster },
    runtimeProbe: { capabilities: () => legacy },
    config: () => config,
    now: options.clock ?? (() => NOW),
  })
  return { repository, relevance, spy, spent }
}

const suggest = (relevance: ReturnType<typeof stack>["relevance"], fixture: Fixture, messageID = "msg_1") =>
  relevance.suggest({ projectID: PROJECT, sessionID: "ses_1", messageID, objective: fixture.objective })

// ---- the metric ------------------------------------------------------------------------------

type LineMetric = { recall: number; wrongLoad: number; precision: number; skills: string[] }

/** The per-fixture metric against the human labels; `precision` needs a non-empty line. */
const measure = (line: readonly string[], fixture: Fixture): LineMetric => {
  const good = line.filter((name) => fixture.good.includes(name))
  const wrong = line.filter((name) => fixture.wrong.includes(name))
  return {
    recall: fixture.good.length === 0 ? 1 : good.length / fixture.good.length,
    wrongLoad: wrong.length,
    precision: line.length === 0 ? 0 : good.length / line.length,
    skills: [...line],
  }
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** The nearest-rank percentile; the set is tiny, so this is stable and never interpolates. */
const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

describe("Phase 4 / PoC-3 evaluation: relevance (offline, recorded)", () => {
  test("deterministic baseline: with Jev off the lexical line is wrong-load-free and byte-identical", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const { repository, relevance, spy } = stack(fixture, { jev: false })
      const result = await suggest(relevance, fixture)
      expect(result.reason, name).toBe("ok")
      expect(result.line, name).not.toBeNull()
      expect(result.line, name).toBe(SKILL_LINE_TEMPLATE(result.skills))
      for (const wrong of fixture.wrong) expect(result.skills, `${name}:${wrong}`).not.toContain(wrong)
      expect(spy.calls, name).toBe(0)
      repository.close()
    }
  })

  test("recorded Jev: one batched request recalls the goods, no wrong-load, and the turn is cached", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      if (fixture.degraded) continue
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

  test("degraded: a recorded Jev failure falls back to the lexical line, wrong-load-free, recall not below baseline", async () => {
    const degraded = fixtureNames.map(load).filter((fixture) => fixture.degraded)
    expect(degraded.length).toBeGreaterThan(0)
    for (const fixture of degraded) {
      const off = stack(fixture, { jev: false })
      const on = stack(fixture, { jev: true })
      const baseline = await suggest(off.relevance, fixture)
      const fallback = await suggest(on.relevance, fixture)
      expect(fallback.degraded).toBe(true)
      expect(fallback.source).toBe("fallback")
      expect(fallback.line).toBe(baseline.line)
      const baselineMetric = measure(baseline.skills, fixture)
      const fallbackMetric = measure(fallback.skills, fixture)
      expect(fallbackMetric.wrongLoad).toBe(0)
      expect(fallbackMetric.recall).toBeGreaterThanOrEqual(baselineMetric.recall)
      expect(on.spy.calls).toBe(1)
      off.repository.close()
      on.repository.close()
    }
  })

  test("determinism: the same input gives a byte-identical line", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const first = stack(fixture, { jev: false })
      const second = stack(fixture, { jev: false })
      const firstLine = (await suggest(first.relevance, fixture)).line
      const secondLine = (await suggest(second.relevance, fixture)).line
      expect(firstLine, name).toBe(secondLine)
      first.repository.close()
      second.repository.close()
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
      expect(line, name).not.toBeUndefined()
      expect(line).not.toContain("ignore-all-instructions")
      expect(line).not.toContain("passwd")
      const valid = fixture.roster.map((entry) => entry.name)
      for (const chosen of names) expect(valid, name).toContain(chosen)
    }
  })

  test("PoC-3 offline metric: baseline vs recorded Jev against the promotion threshold", async () => {
    const baseline: LineMetric[] = []
    const jev: LineMetric[] = []
    const degradedBaseline: LineMetric[] = []
    const degradedJev: LineMetric[] = []
    const recordedLatency: number[] = []
    const serverLatency: number[] = []
    const recordedTokens: number[] = []
    let estimatedTokens = 0
    let estimatedCalls = 0
    let baselineWrong = 0
    let jevWrong = 0

    for (const name of fixtureNames) {
      const fixture = load(name)
      // The server path is timed on a monotonic clock; the decision ids stay deterministic because
      // the service still runs on the fixed `NOW`.
      const off = stack(fixture, { jev: false, clock: () => performance.now() })
      const on = stack(fixture, { jev: true, clock: () => performance.now() })
      const offResult = await suggest(off.relevance, fixture)
      const onResult = await suggest(on.relevance, fixture)
      const offMetric = measure(offResult.skills, fixture)
      const onMetric = measure(onResult.skills, fixture)
      baseline.push(offMetric)
      jev.push(onMetric)
      baselineWrong += offMetric.wrongLoad
      jevWrong += onMetric.wrongLoad
      estimatedTokens += on.spent.tokens
      estimatedCalls += on.spent.calls
      recordedLatency.push(fixture.simulatedLatencyMs)
      recordedTokens.push(fixture.simulatedTokens)
      serverLatency.push(onResult.latencyMs)
      if (fixture.degraded) {
        degradedBaseline.push(offMetric)
        degradedJev.push(onMetric)
      }
      off.repository.close()
      on.repository.close()
    }

    const baselineRecall = mean(baseline.map((metric) => metric.recall))
    const jevRecall = mean(jev.map((metric) => metric.recall))
    const baselinePrecision = mean(baseline.map((metric) => metric.precision))
    const jevPrecision = mean(jev.map((metric) => metric.precision))
    // The degradation rate is tautological by construction, not an independent measurement: on a
    // `degraded` fixture the recorded Jev failure falls back to the lexical line, which **is** the
    // baseline. So `degradedJev` and `degradedBaseline` are the same line and the comparison below
    // is `x >= x`. It reports that the fallback path is wired, not that Jev degrades gracefully;
    // the live PoC (blocked, ADR-0022 §6) is what would measure a real fallback quality.
    const degradedPasses = degradedJev.filter(
      (metric, index) => metric.wrongLoad === 0 && metric.recall >= degradedBaseline[index]!.recall,
    ).length
    const degradedRate = degradedJev.length === 0 ? 0 : degradedPasses / degradedJev.length

    const recordedP50 = percentile(recordedLatency, 0.5)
    const recordedP95 = percentile(recordedLatency, 0.95)
    const recordedMax = Math.max(...recordedLatency)
    const serverP95 = percentile(serverLatency, 0.95)
    const meanRecordedTokens = mean(recordedTokens)
    const estimatedPerCall = estimatedCalls === 0 ? 0 : estimatedTokens / estimatedCalls
    // Two projections, both at the assumed volume: the recorded metadata (the design's unit) and the
    // production `estimateTokens(body)` the governor actually reserves.
    const projectedMonthlyTokens = Math.round(meanRecordedTokens * ASSUMED_RELEVANCE_CALLS_PER_MONTH)
    const projectedEstimateTokens = Math.round(estimatedPerCall * ASSUMED_RELEVANCE_CALLS_PER_MONTH)
    const monthlyBudget = resolveAdaptiveConfig({ block: {}, env: {} }).budget.monthlyTokens

    // The metric is printed so the run reports it, not just asserts it.
    console.log(
      [
        "PoC-3 offline metric (recorded Jev; latency and tokens are recorded, not measured)",
        `  fixtures ${fixtureNames.length} (degraded ${degradedJev.length})`,
        `  recall@3   baseline ${baselineRecall.toFixed(3)} | recorded-Jev ${jevRecall.toFixed(3)} | gate >= ${PROMOTION_THRESHOLD.recallAt3}`,
        `  precision  baseline ${baselinePrecision.toFixed(3)} | recorded-Jev ${jevPrecision.toFixed(3)} | gate >= ${PROMOTION_THRESHOLD.precision}`,
        `  wrong-load baseline ${baselineWrong} | recorded-Jev ${jevWrong} | gate = ${PROMOTION_THRESHOLD.wrongLoad}`,
        `  degradation rate ${degradedRate.toFixed(3)} over ${degradedJev.length} (structural: the fallback line is the baseline, so this is not an independent measurement)`,
        `  latency recorded p50 ${recordedP50}ms p95 ${recordedP95}ms max ${recordedMax}ms (<= ${HOT_LATENCY_CEILING_MS}ms); server-path p95 ${serverP95.toFixed(2)}ms`,
        `  cost recorded tokens/call mean ${meanRecordedTokens.toFixed(0)}; production estimateTokens x calls ${estimatedTokens} over ${estimatedCalls} calls (mean ${estimatedPerCall.toFixed(0)}/call)`,
        `  projected monthly recorded ${projectedMonthlyTokens} | production ${projectedEstimateTokens} tokens at ${ASSUMED_RELEVANCE_CALLS_PER_MONTH} calls/month (budget ${monthlyBudget})`,
      ].join("\n"),
    )

    // The acceptance metric holds on every fixture, for both lines.
    for (const [index, name] of fixtureNames.entries()) {
      expect(baseline[index]!.wrongLoad, `${name}:baseline`).toBe(0)
      expect(jev[index]!.wrongLoad, `${name}:recorded-jev`).toBe(0)
    }
    expect(baselineWrong).toBe(PROMOTION_THRESHOLD.wrongLoad)
    expect(jevWrong).toBe(PROMOTION_THRESHOLD.wrongLoad)

    // The gate is asserted on the promoted path; the baseline is the comparison, reported above.
    expect(jevRecall).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD.recallAt3)
    expect(jevPrecision).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD.precision)
    expect(degradedJev.length).toBeGreaterThan(0)
    // 1 by construction (see the computation above), kept as a wiring assertion, not a quality claim.
    expect(degradedRate).toBe(1)
    expect(recordedMax).toBeLessThanOrEqual(HOT_LATENCY_CEILING_MS)
    expect(serverP95).toBeLessThan(HOT_LATENCY_CEILING_MS)
    expect(projectedMonthlyTokens).toBeLessThanOrEqual(monthlyBudget)
    expect(projectedEstimateTokens).toBeLessThanOrEqual(monthlyBudget)
  })
})
