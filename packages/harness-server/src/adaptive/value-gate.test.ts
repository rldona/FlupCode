import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { StoredDecisionInput } from "../types"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionLabelOutcome, DecisionRequest } from "./decision"
import { decisionID } from "./decision-record"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import type { Prediction, PredictiveModel } from "./predictive/model"
import { createGovernor } from "./providers/governor"
import { createValueGate, explores, gateStatus, handleValueGateRead, P95_MIN_SAMPLES, valueStats } from "./value-gate"

const NOW = 1_700_000_000_000
const COMPLETE = { verdict: "complete" as const }
const NOT_COMPLETE = { verdict: "not_complete" as const }

/** A labelled row the stats read: whether the model disagreed, and how each answer scored. */
const labeled = (disagrees: boolean, outcome: DecisionLabelOutcome, baselineOutcome: DecisionLabelOutcome) => ({
  answer: disagrees ? NOT_COMPLETE : COMPLETE,
  baselineAnswer: COMPLETE,
  label: { outcome, baselineOutcome, source: "sim", labeledAt: NOW },
})

const configWith = (voi: Record<string, unknown> = {}) =>
  resolveAdaptiveConfig({
    env: {},
    block: {
      models: { completion: "jev" },
      egress: { providers: { jev: { enabled: true, projects: ["/work/project"], kinds: { completion: true } } } },
      voi,
    },
  })

/** A scope id the 5% exploration sample does (or does not) send to the model. */
const scopeWhere = (explored: boolean, rate = 0.05) =>
  Array.from({ length: 10_000 }, (_, index) => `scope-${index}`).find(
    (scope) => explores(scope, "completion", "jev", rate) === explored,
  )!

/** A model decision row as the service writes it, for seeding the audit directly. */
const row = (input: {
  id: string
  version?: string
  answer?: unknown
  latencyMs?: number
  costUsd?: number
  source?: "model" | "fallback"
  degradedReason?: "timeout"
}): StoredDecisionInput => ({
  id: input.id,
  kind: "completion",
  inputsHash: input.id,
  stateSummary: {},
  answer: input.answer ?? NOT_COMPLETE,
  baselineAnswer: COMPLETE,
  baselineRule: "episode-outcome",
  provider: input.source === "fallback" ? "deterministic" : "jev",
  attemptedProvider: "jev",
  source: input.source ?? "model",
  providerID: "jev",
  ...(input.version !== undefined ? { providerVersion: input.version, modelVersion: input.version } : {}),
  ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
  degraded: input.source === "fallback",
  ...(input.degradedReason ? { degradedReason: input.degradedReason } : {}),
  latencyMs: input.latencyMs ?? 50,
  policy: DEFAULT_DECISION_POLICY,
  shadow: true,
})

describe("the rolling value stats", () => {
  test("disagreement is the share of judged rows whose answer differs, and uplift compares accuracy on them", () => {
    const stats = valueStats([
      labeled(true, "correct", "incorrect"),
      labeled(true, "correct", "incorrect"),
      labeled(true, "incorrect", "correct"),
      labeled(true, "correct", "correct"),
      labeled(false, "correct", "correct"),
      labeled(false, "incorrect", "incorrect"),
      labeled(false, "correct", "correct"),
      labeled(false, "correct", "correct"),
    ])
    expect(stats.samples).toBe(8)
    expect(stats.disagreements).toBe(4)
    expect(stats.disagreementRate).toBe(0.5)
    // acc(model | disagree) = 3/4, acc(baseline | disagree) = 2/4.
    expect(stats.uplift).toBeCloseTo(0.25)
  })

  test("a row whose label judged either answer unknown, or carries no label, is not a sample", () => {
    const stats = valueStats([
      labeled(true, "unknown", "correct"),
      labeled(true, "correct", "unknown"),
      { answer: NOT_COMPLETE, baselineAnswer: COMPLETE },
      labeled(true, "correct", "incorrect"),
    ])
    expect(stats.samples).toBe(1)
    expect(stats.uplift).toBe(1)
  })

  test("a model that never disagrees has no uplift, and a set answer in another order still agrees", () => {
    expect(valueStats([labeled(false, "correct", "correct")]).uplift).toBe(0)
    const reordered = valueStats([
      {
        answer: { load: ["b", "a"] },
        baselineAnswer: { load: ["a", "b"] },
        label: { outcome: "correct", baselineOutcome: "correct", source: "sim", labeledAt: NOW },
      },
    ])
    expect(reordered.disagreements).toBe(0)
  })
})

describe("the gate state", () => {
  const voi = configWith().voi
  const status = (rows: ReturnType<typeof labeled>[], calls: Array<{ latencyMs: number; costUsd?: number }> = []) =>
    gateStatus({ kind: "completion", modelID: "jev", samples: { version: "v1", labeled: rows, calls }, voi })

  test("warms up below the minimum samples, whatever they say", () => {
    const rows = Array.from({ length: voi.minSamples - 1 }, () => labeled(true, "incorrect", "correct"))
    expect(status(rows).state).toBe("warming-up")
  })

  test("pauses once warmed up when the uplift is at most epsilon", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0 ? labeled(true, "correct", "incorrect") : labeled(true, "incorrect", "correct"),
    )
    const paused = status(rows)
    expect(paused.uplift).toBe(0)
    expect(paused.state).toBe("paused")
  })

  test("asks when disagreement × uplift × valueOfCorrect beats cost plus latency, and explores when it does not", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => labeled(true, "correct", "incorrect")),
      ...Array.from({ length: 30 }, () => labeled(false, "correct", "correct")),
    ]
    // disagreement 0.25 × uplift 1 × 0.05 = 0.0125 USD per decision.
    const cheap = status(rows, [{ latencyMs: 100, costUsd: 0.001 }])
    expect(cheap.valueUsd).toBeCloseTo(0.0125)
    expect(cheap.costUsd).toBeCloseTo(0.001 + 0.0001)
    expect(cheap.state).toBe("asking")
    const dear = status(rows, [{ latencyMs: 100, costUsd: 0.02 }])
    expect(dear.state).toBe("exploring")
  })

  test("the p95 is the nearest-rank percentile of the measured calls", () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({ latencyMs: (index + 1) * 10 }))
    expect(status([], calls).p95LatencyMs).toBe(190)
    expect(status([], calls).latencySamples).toBe(20)
  })
})

describe("exploration", () => {
  test("is deterministic per scope and keeps about the configured share", () => {
    expect(explores("scope-a", "completion", "jev", 0.05)).toBe(explores("scope-a", "completion", "jev", 0.05))
    const hits = Array.from({ length: 10_000 }, (_, index) => explores(`s${index}`, "completion", "jev", 0.05)).filter(
      Boolean,
    ).length
    expect(hits / 10_000).toBeGreaterThan(0.04)
    expect(hits / 10_000).toBeLessThan(0.06)
    expect(explores("scope-a", "completion", "jev", 0)).toBe(false)
  })
})

describe("the gate over the audit", () => {
  const seeded = (voi: Record<string, unknown> = {}, now = () => NOW) => {
    const repository = new SqliteRoutineRepository(":memory:")
    const config = configWith({ statsTtlMs: 0, ...voi })
    const gate = createValueGate({ repository, config: () => config, now })
    return { repository, gate }
  }

  const seedPaused = (repository: SqliteRoutineRepository, version = "v1", at = NOW) =>
    Array.from({ length: 40 }, (_, index) => {
      const id = `completion:${version}:${index}`
      repository.createDecision(row({ id, version, costUsd: 0 }), at + index)
      repository.labelDecision(id, {
        outcome: index % 2 === 0 ? "correct" : "incorrect",
        baselineOutcome: index % 2 === 0 ? "incorrect" : "correct",
        source: "sim",
      })
    })

  test("pauses a model that adds nothing, lets only the exploration sample through, and says why", () => {
    const { repository, gate } = seeded()
    seedPaused(repository)
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID: scopeWhere(false) })).toEqual({
      ask: false,
      reason: "voi-paused",
    })
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID: scopeWhere(true) })).toEqual({
      ask: true,
      explored: true,
    })
    expect(gate.status().kinds).toMatchObject([{ kind: "completion", modelID: "jev", state: "paused", samples: 40 }])
    repository.close()
  })

  test("lifts the pause once the explored decisions show a positive uplift", () => {
    const { repository, gate } = seeded()
    seedPaused(repository)
    expect(gate.status().kinds[0]!.state).toBe("paused")
    Array.from({ length: 10 }, (_, index) => {
      const id = `completion:explored:${index}`
      repository.createDecision(row({ id, version: "v1", costUsd: 0 }), NOW + 1_000 + index)
      repository.labelDecision(id, { outcome: "correct", baselineOutcome: "incorrect", source: "sim" })
    })
    expect(gate.status().kinds[0]!.state).toBe("asking")
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID: scopeWhere(false) }).ask).toBe(true)
    repository.close()
  })

  test("a new model version starts its stats from zero", () => {
    const { repository, gate } = seeded()
    seedPaused(repository, "v1")
    expect(gate.status().kinds[0]!.state).toBe("paused")
    repository.createDecision(row({ id: "completion:v2:0", version: "v2", costUsd: 0 }), NOW + 1_000)
    expect(gate.status().kinds[0]).toMatchObject({ modelVersion: "v2", samples: 0, state: "warming-up" })
    repository.close()
  })

  test("skips a hot decision whose measured p95 exceeds the deadline, but never a batch one", () => {
    const { repository, gate } = seeded()
    Array.from({ length: P95_MIN_SAMPLES }, (_, index) =>
      repository.createDecision(
        row({ id: `completion:slow:${index}`, version: "v1", costUsd: 0, latencyMs: 900 }),
        NOW + index,
      ),
    )
    const scopeID = scopeWhere(false)
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID, deadlineMs: 400 })).toEqual({
      ask: false,
      reason: "p95-over-deadline",
    })
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID, deadlineMs: 1_000 }).ask).toBe(true)
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID }).ask).toBe(true)
    repository.close()
  })

  test("a timeout counts toward the p95, and too few calls say nothing", () => {
    const { repository, gate } = seeded()
    Array.from({ length: P95_MIN_SAMPLES - 1 }, (_, index) =>
      repository.createDecision(
        row({ id: `completion:timeout:${index}`, source: "fallback", degradedReason: "timeout", latencyMs: 900 }),
        NOW + index,
      ),
    )
    const scopeID = scopeWhere(false)
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID, deadlineMs: 400 }).ask).toBe(true)
    repository.createDecision(
      row({ id: "completion:timeout:last", source: "fallback", degradedReason: "timeout", latencyMs: 900 }),
      NOW + 100,
    )
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID, deadlineMs: 400 })).toMatchObject({ ask: false })
    repository.close()
  })

  test("switched off, it asks and caches nothing", () => {
    const { repository, gate } = seeded({ enabled: false })
    seedPaused(repository)
    expect(gate.verdict({ kind: "completion", modelID: "jev", scopeID: scopeWhere(false) }).ask).toBe(true)
    gate.remember("completion", "jev", "hash", { answer: COMPLETE, providerID: "jev", version: "v1" })
    expect(gate.recall("completion", "jev", "hash")).toBeUndefined()
    repository.close()
  })

  test("caches the model's answer per inputs hash until the kind's TTL, and never across a version", () => {
    let clock = NOW
    const { repository, gate } = seeded({ kinds: { completion: { cacheTtlMs: 1_000 } } }, () => clock)
    repository.createDecision(row({ id: "completion:seen", version: "v1", costUsd: 0 }), NOW)
    const prediction = { answer: NOT_COMPLETE, providerID: "jev", version: "v1", confidence: 0.9 }
    expect(gate.recall("completion", "jev", "hash")).toBeUndefined()
    gate.remember("completion", "jev", "hash", prediction)
    expect(gate.recall("completion", "jev", "hash")).toEqual(prediction)
    expect(gate.recall("completion", "jev", "other")).toBeUndefined()
    clock += 1_000
    expect(gate.recall("completion", "jev", "hash")).toBeUndefined()

    gate.remember("completion", "jev", "hash", prediction)
    repository.createDecision(row({ id: "completion:upgraded", version: "v2", costUsd: 0 }), NOW + 10)
    expect(gate.recall("completion", "jev", "hash")).toBeUndefined()
    repository.close()
  })

  test("the cache is a bounded LRU", () => {
    const { repository, gate } = seeded({ cacheMaxEntries: 2 })
    const prediction = { answer: COMPLETE, providerID: "jev" }
    gate.remember("completion", "jev", "a", prediction)
    gate.remember("completion", "jev", "b", prediction)
    // Reading `a` makes `b` the least recently used, so `c` evicts it.
    expect(gate.recall("completion", "jev", "a")).toBeDefined()
    gate.remember("completion", "jev", "c", prediction)
    expect(gate.recall("completion", "jev", "b")).toBeUndefined()
    expect(gate.recall("completion", "jev", "a")).toBeDefined()
    expect(gate.recall("completion", "jev", "c")).toBeDefined()
    repository.close()
  })

  test("serves stats from its cache within the TTL, so the hot path does not query each time", () => {
    let clock = NOW
    const repository = new SqliteRoutineRepository(":memory:")
    const config = configWith({ statsTtlMs: 30_000 })
    const reads: number[] = []
    const gate = createValueGate({
      repository: { listValueSamples: (input) => (reads.push(1), repository.listValueSamples(input)) },
      config: () => config,
      now: () => clock,
    })
    gate.status()
    gate.status()
    expect(reads).toHaveLength(1)
    clock += 30_000
    gate.status()
    expect(reads).toHaveLength(2)
    repository.close()
  })
})

describe("the gate in the decision service (AH-C05 simulation)", () => {
  const completion = (scope: string): DecisionRequest<"completion"> => ({
    kind: "completion",
    scopeID: scope,
    episodeID: `episode:${scope}`,
    projectID: "/work/project",
    policy: DEFAULT_DECISION_POLICY,
    state: {
      episodeID: `episode:${scope}`,
      objective: `objective ${scope}`,
      outcome: "success",
      toolCalls: 1,
      verifications: [{ step: "test", ok: true }],
      failures: 0,
      projectID: "/work/project",
    },
  })

  /** A model that always answers `not_complete`, so it disagrees with the baseline every time. */
  const contrarian = (): PredictiveModel & { calls: number } => {
    const model = {
      id: "jev",
      locality: "remote" as const,
      supports: decisionKinds(),
      calls: 0,
      predict: async (_state: unknown, questions: readonly { id: string }[]): Promise<Prediction> => {
        model.calls += 1
        return {
          answers: Object.fromEntries(
            questions.map((question) => [question.id, { probabilities: { yes: 0.1, no: 0.9 } }]),
          ),
          latencyMs: 20,
          usage: { inputTokens: 10, costUsd: 0.0005 },
          model: { id: "jev", version: "v1" },
        }
      },
    }
    return model
  }

  const simulate = (voi: Record<string, unknown> = {}) => {
    let clock = NOW
    const repository = new SqliteRoutineRepository(":memory:")
    const config = configWith({ statsTtlMs: 0, cacheTtlMs: 0, ...voi })
    const model = contrarian()
    const valueGate = createValueGate({ repository, config: () => config, now: () => clock })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      models: [model],
      governor: createGovernor({
        config: () => ({ ...config.governor, monthlyTokenBudget: 1_000_000_000 }),
        store: repository,
        now: () => clock,
      }),
      valueGate,
      now: () => clock,
    })
    /** One decision, labelled at once as the labeler would; returns whether the model answered it. */
    const decide = async (index: number, modelRight: (index: number) => boolean) => {
      clock += 1_000
      const scope = `sim-${index}`
      const result = await service.predict(completion(scope))
      const id = decisionID("completion", scope)
      if (result.source === "model") {
        const right = modelRight(index)
        repository.labelDecision(id, {
          outcome: right ? "correct" : "incorrect",
          baselineOutcome: right ? "incorrect" : "correct",
          source: "sim",
        })
      }
      return result
    }
    return { repository, model, service, valueGate, decide }
  }

  test("a model that adds nothing pauses within N = 200 decisions, and exploration keeps ~5% reaching it", async () => {
    const { repository, model, decide, valueGate } = simulate()
    // Right exactly half the time it disagrees: acc(model | disagree) = acc(baseline | disagree).
    const coinFlip = (index: number) => index % 2 === 0
    const first = await Array.from({ length: 200 }, (_, index) => index).reduce<Promise<number | undefined>>(
      async (found, index) =>
        (await found) ?? ((await decide(index, coinFlip)).source === "baseline" ? index : undefined),
      Promise.resolve(undefined),
    )
    expect(first).toBeDefined()
    expect(first!).toBeLessThan(200)
    expect(valueGate.status().kinds[0]!.state).toBe("paused")

    const before = model.calls
    const paused = await Array.from({ length: 2_000 }, (_, index) => 1_000 + index).reduce<Promise<number>>(
      async (count, index) => (await count) + ((await decide(index, coinFlip)).source === "baseline" ? 1 : 0),
      Promise.resolve(0),
    )
    const explored = model.calls - before
    expect(explored + paused).toBe(2_000)
    expect(explored / 2_000).toBeGreaterThan(0.03)
    expect(explored / 2_000).toBeLessThan(0.07)
    expect(valueGate.status().kinds[0]!.state).toBe("paused")

    const skipped = repository
      .listDecisions({ kind: "completion", limit: 500 })
      .find((row) => row.source === "baseline")
    expect(skipped).toMatchObject({ provider: "deterministic", degraded: true, degradedReason: "voi-paused" })
    expect(skipped!.providerID).toBeUndefined()
    repository.close()
  })

  test("a model that adds value keeps being asked", async () => {
    const { repository, model, decide, valueGate } = simulate()
    // Right nine times in ten when it disagrees.
    const results = await Array.from({ length: 400 }, (_, index) => index).reduce<Promise<string[]>>(
      async (sources, index) => [...(await sources), (await decide(index, (i) => i % 10 !== 0)).source],
      Promise.resolve([]),
    )
    expect(results.every((source) => source === "model")).toBe(true)
    expect(model.calls).toBe(400)
    expect(valueGate.status().kinds[0]).toMatchObject({ state: "asking", samples: 200 })
    repository.close()
  })

  test("a repeated input reuses the model's answer without asking again, and records no cost for it", async () => {
    const { repository, model, service } = simulate({ cacheTtlMs: 60_000 })
    await service.predict(completion("same"))
    const again = await service.predict({ ...completion("same"), scopeID: "same-again" })
    expect(model.calls).toBe(1)
    expect(again.source).toBe("model")
    expect(again.answer).toEqual(NOT_COMPLETE)
    const stored = repository.getDecision(decisionID("completion", "same-again"))
    expect(stored).toMatchObject({ source: "model", providerID: "jev", providerVersion: "v1" })
    expect(stored!.costUsd).toBeUndefined()
    repository.close()
  })

  test("explain says a paused decision was not sent to the model and why", async () => {
    const { repository, service, decide } = simulate()
    await Array.from({ length: 60 }, (_, index) => index).reduce<Promise<unknown>>(
      async (previous, index) => (await previous, decide(index, (i) => i % 2 === 0)),
      Promise.resolve(undefined),
    )
    const skipped = repository
      .listDecisions({ kind: "completion", limit: 100 })
      .find((row) => row.source === "baseline")
    expect(service.explain(skipped!.id)?.why).toContain("does not improve this decision")
    repository.close()
  })
})

describe("the gate status route", () => {
  test("answers every assigned kind's gate under the artifacts bearer, and is announced", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const config = configWith()
    const valueGate = createValueGate({ repository, config: () => config, now: () => NOW })
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { token: "secret", valueGate })

    expect((await handler(new Request("http://x/harness/adaptive/voi"))).status).toBe(403)
    const response = await handler(
      new Request("http://x/harness/adaptive/voi", { headers: { authorization: "Bearer secret" } }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({ enabled: true, window: 200, minSamples: 30, explorationRate: 0.05 })
    expect(body.data.kinds).toMatchObject([{ kind: "completion", modelID: "jev", state: "warming-up", samples: 0 }])

    const health = await (await handler(new Request("http://x/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-voi")
    expect(await handleValueGateRead(valueGate).json()).toEqual(body)
    repository.close()
  })

  test("is an ordinary 404 without a gate", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, {})
    expect((await handler(new Request("http://x/harness/adaptive/voi"))).status).toBe(404)
    repository.close()
  })
})
