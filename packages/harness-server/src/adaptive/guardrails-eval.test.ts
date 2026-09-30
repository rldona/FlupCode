/**
 * The E7 / FH-060–063 evaluation, offline (ADR-0023).
 *
 * This is a deliverable, not a unit test: it states the detector's metric with **no network and no
 * model** over a curated, labelled set of loop and non-loop traces
 * (`fixtures/guardrails/*.json`). The threshold is the false-positive guard the plan asks for: every
 * loop detected, no false positive on a normal retry, and the gate fixtures (off, off-legacy) inert.
 *
 * The recorded Jev answer is replayed through the real `DecisionService` + `JevClient` + `EgressGuard`
 * exactly as `relevance-eval.test.ts` does; the only injected thing is the `fetch` that returns the
 * fixture. A degraded replay proves the deterministic baseline is kept.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../repository"
import { resolveAdaptiveConfig } from "./config"
import { createAdaptiveEgressGuard } from "./egress"
import { createDecisionService } from "./decision-service"
import type { DecisionSource } from "./decision"
import { createGuardrailService } from "./guardrails"
import type { GuardrailReason, GuardrailResult } from "./guardrails"
import type { LoopObservation } from "./guardrails-detector"
import { createGovernor } from "./providers/governor"
import type { GovernorStore } from "./providers/governor"
import { createJevClient, createJevModel } from "./providers/jev"
import type { JevFetch, JevFetchResponse } from "./providers/jev"
import type { JevAnswer } from "./providers/jev-parse"
import { createRetryingModel } from "./providers/retry"
import type { RuntimeCapabilities } from "./runtime"

const NOW = 1_700_000_000_000
const PROJECT = "/work/project"

/**
 * The offline gate for E7. `detection` is the share of labelled loops that must be detected;
 * `falsePositives` is the absolute count of non-loops that may be flagged. Both are acceptance
 * metrics: a detector that never fires is not useful, and one that fires on a retry is worse.
 */
export const GUARDRAIL_EVAL = { falsePositives: 0, detection: 1.0 } as const

type Fixture = {
  id: string
  description: string
  loop: boolean
  observations: LoopObservation[]
  config?: Record<string, unknown>
  runtime?: "legacy" | "v2"
  jev?: { model: string; failure: JevAnswer; toolRisk: JevAnswer }
  expect: {
    verdict: "continue" | "intervene"
    reason: GuardrailReason
    decision: boolean
    repeatedCalls?: number
    repeatedErrors?: number
    source?: DecisionSource
    risk?: string
  }
}

const fixtureNames = [
  "loop-identical-calls",
  "repeated-errors",
  "arg-changed",
  "normal-retry",
  "flaky-nonconsecutive",
  "mixed-error-call",
  "disabled",
  "runtime-v2",
  "failure-jev-recorded",
] as const

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "guardrails", `${name}.json`), "utf8")) as Fixture

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

const v2: RuntimeCapabilities = { ...legacy, runtime: "v2", degraded: true, canObserveToolCalls: false }

const capabilities = (fixture: Fixture): RuntimeCapabilities => (fixture.runtime === "v2" ? v2 : legacy)

/** A recorded Jev body for one answer; the single question is always `w0`. */
const recorded = (model: string, answer: JevAnswer): JevFetchResponse => ({
  ok: true,
  status: 200,
  headers: new Headers({}),
  json: async () => ({ model, answers: { w0: answer } }),
})

const recordedFetch = (fixture: Fixture): JevFetch => async ({ body }) => {
  const parsed: unknown = JSON.parse(body)
  const questions = parsed && typeof parsed === "object" ? (parsed as { questions?: Array<{ prompt?: unknown }> }).questions : undefined
  const prompt = Array.isArray(questions) && typeof questions[0]?.prompt === "string" ? questions[0].prompt : ""
  // The two decisions are separate requests; the prompt tells them apart.
  if (prompt.startsWith("Should the harness intervene")) return recorded(fixture.jev!.model, fixture.jev!.failure)
  return recorded(fixture.jev!.model, fixture.jev!.toolRisk)
}

/** A recorded Jev failure: the fallback records `timeout` and the deterministic baseline runs. */
const recordedTimeout = (): Error => {
  const error = new Error("recorded timeout")
  error.name = "TimeoutError"
  return error
}

const stack = (fixture: Fixture, options: { degraded?: boolean } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({ block: { guardrails: { enabled: true }, ...(fixture.config ?? {}) }, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const spent = { tokens: 0, calls: 0 }
  const store: GovernorStore = {
    adaptiveUsage: () => ({ ...spent }),
    addAdaptiveUsage: (_month, tokens, calls) => {
      spent.tokens += tokens
      spent.calls += calls
    },
  }
  const governor = createGovernor({ config: () => config.governor, store, now: () => NOW })
  const fetch: JevFetch = async (input) => {
    if (options.degraded) throw recordedTimeout()
    return recordedFetch(fixture)(input)
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
  const guardrails = createGuardrailService({
    service,
    runtimeProbe: { capabilities: () => capabilities(fixture) },
    config: () => config,
    now: () => NOW,
  })
  return { repository, guardrails, spent }
}

const run = async (fixture: Fixture, options: { degraded?: boolean } = {}): Promise<GuardrailResult> => {
  const stackForFixture = stack(fixture, options)
  const results: GuardrailResult[] = []
  for (const observation of fixture.observations) {
    results.push(await stackForFixture.guardrails.observe({ projectID: PROJECT, sessionID: "ses_1", observation }))
  }
  stackForFixture.repository.close()
  return results[results.length - 1]!
}

describe("E7 / FH-060–063 evaluation: failure/loop guardrails (offline, recorded)", () => {
  test("every fixture answers what it was labelled for", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const result = await run(fixture)
      expect(result.verdict, name).toBe(fixture.expect.verdict)
      expect(result.reason, name).toBe(fixture.expect.reason)
      if (fixture.expect.repeatedCalls !== undefined)
        expect(result.repeatedCalls, name).toBe(fixture.expect.repeatedCalls)
      if (fixture.expect.repeatedErrors !== undefined)
        expect(result.repeatedErrors, name).toBe(fixture.expect.repeatedErrors)
      if (fixture.expect.source !== undefined) expect(result.source, name).toBe(fixture.expect.source)
      if (fixture.expect.risk !== undefined) expect(result.risk?.risk as string | undefined, name).toBe(fixture.expect.risk)
      // A gate fixture and a below-threshold trace write nothing; a detected loop writes a row.
      const rows = fixture.expect.decision ? 1 : 0
      expect(result.decisionID === undefined ? 0 : 1, name).toBe(rows)
    }
  })

  test("false positives: no non-loop trace is flagged", async () => {
    let flagged = 0
    for (const name of fixtureNames) {
      const fixture = load(name)
      if (fixture.loop) continue
      const result = await run(fixture)
      if (result.verdict === "intervene") flagged += 1
    }
    expect(flagged).toBe(GUARDRAIL_EVAL.falsePositives)
  })

  test("detection: every labelled loop is detected", async () => {
    const positives = fixtureNames
      .map(load)
      .filter((fixture) => fixture.expect.decision)
    const detected = (await Promise.all(positives.map((fixture) => run(fixture)))).filter(
      (result) => result.verdict === "intervene",
    )
    const detection = positives.length === 0 ? 0 : detected.length / positives.length
    console.log(
      [
        "E7 offline metric (recorded Jev; no network, no model)",
        `  fixtures ${fixtureNames.length} (loops ${positives.length})`,
        `  detection ${detection.toFixed(3)} over ${positives.length} | gate >= ${GUARDRAIL_EVAL.detection}`,
        `  false positives ${GUARDRAIL_EVAL.falsePositives} | gate = ${GUARDRAIL_EVAL.falsePositives}`,
      ].join("\n"),
    )
    expect(detection).toBeGreaterThanOrEqual(GUARDRAIL_EVAL.detection)
  })

  test("the gate fixtures are inert: off touches nothing, off-legacy writes nothing", async () => {
    const disabled = await run(load("disabled"))
    expect(disabled).toMatchObject({ verdict: "continue", reason: "disabled", steps: "unsupported" })
    expect(disabled.decisionID).toBeUndefined()

    const offLegacy = await run(load("runtime-v2"))
    expect(offLegacy).toMatchObject({ verdict: "continue", reason: "runtime-not-legacy" })
    expect(offLegacy.decisionID).toBeUndefined()
  })

  test("a recorded Jev answer decides the loop and its risk is capped", async () => {
    const result = await run(load("failure-jev-recorded"))
    expect(result).toMatchObject({
      verdict: "intervene",
      source: "model",
      degraded: false,
      risk: { risk: "CONFIRM", raiseOnly: true },
    })
  })

  test("a degraded Jev answer keeps the deterministic baseline", async () => {
    const result = await run(load("failure-jev-recorded"), { degraded: true })
    expect(result).toMatchObject({
      verdict: "intervene",
      source: "fallback",
      degraded: true,
      risk: { risk: "ALLOW", raiseOnly: true },
    })
  })
})
