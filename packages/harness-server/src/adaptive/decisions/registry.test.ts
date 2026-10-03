import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import { DECISION_KINDS, DEFAULT_DECISION_POLICY, decisionKinds } from "../decision"
import { createDecisionService } from "../decision-service"
import { createAdaptiveEgressGuard } from "../egress"
import { priority } from "../fixtures/decisions/toy-priority"
import type { PredictionState, PredictiveModel } from "../predictive/model"
import { createGovernor } from "../providers/governor"
import { SqliteRoutineRepository } from "../../repository"
import { createDecisionRegistry, defineDecision } from "./define"
import { BUILT_IN_DECISIONS, DECISIONS } from "./registry"

const NOW = 1_700_000_000_000

/** A local model that says "high" with 0.9 and records what it was handed. */
const recordingModel = (overrides: Partial<PredictiveModel> = {}) => {
  const seen: PredictionState[] = []
  const model: PredictiveModel = {
    id: "toy-model",
    locality: "local",
    predict: async (state, questions) => {
      seen.push(state)
      return {
        answers: Object.fromEntries(questions.map((question) => [question.id, { probabilities: { yes: 0.9, no: 0.1 } }])),
        latencyMs: 1,
        usage: { inputTokens: 1, costUsd: 0 },
        model: { id: "toy-model", version: "1" },
      }
    },
    ...overrides,
  }
  return { model, seen }
}

/** A service over the server's kinds plus the toy one, with `assigned` naming the model per kind. */
const serviceWith = (model: PredictiveModel, assigned: Record<string, string>) => {
  const base = resolveAdaptiveConfig({ block: {}, env: {} })
  const config = { ...base, models: assigned }
  const decisions = createDecisionRegistry([...BUILT_IN_DECISIONS, priority])
  const repository = new SqliteRoutineRepository(":memory:")
  const service = createDecisionService({
    repository,
    config: () => config,
    egress: createAdaptiveEgressGuard({ config: () => config, decisions }),
    decisions,
    models: [model],
    governor: createGovernor({
      config: () => config.governor,
      store: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      now: () => NOW,
    }),
    now: () => NOW,
  })
  return { service, repository }
}

const toyRequest = {
  kind: "priority" as const,
  state: { title: "Checkout fails", labels: ["urgent"], reporter: "someone@example.com" },
  policy: DEFAULT_DECISION_POLICY,
  scopeID: "issue-1",
}

describe("the decision registry (PI-02)", () => {
  test("the server's kinds are the registry's, in its order", () => {
    expect([...DECISIONS.kinds]).toEqual(["completion", "skillRelevance", "contextItem", "failure", "skillReflection", "modelRoute"])
    expect(decisionKinds()).toEqual([...DECISIONS.kinds])
    expect(Object.keys(DECISION_KINDS)).toEqual([...DECISIONS.kinds])
  })

  test("two definitions of one kind are refused", () => {
    expect(() => createDecisionRegistry([priority, priority])).toThrow("unique")
  })

  test("a kind added from one file is answered by its baseline with no model", async () => {
    const { service, repository } = serviceWith(recordingModel().model, {})
    const result = await service.predict({ ...toyRequest, state: { ...toyRequest.state, labels: [] } })
    expect(result).toMatchObject({ kind: "priority", answer: { level: "low" }, source: "baseline", baselineRule: "urgent-label" })
    repository.close()
  })

  test("a kind added from one file is asked of a model, read back, and audited", async () => {
    const { model, seen } = recordingModel()
    const { service, repository } = serviceWith(model, { priority: "toy-model" })
    const result = await service.predict(toyRequest)
    expect(result).toMatchObject({
      kind: "priority",
      answer: { level: "high" },
      source: "model",
      provider: "toy-model",
      probabilities: { high: 0.9, low: expect.closeTo(0.1) },
      baseline: { level: "high" },
    })
    // The kind's egress decides what leaves: the reporter stays on the machine.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe("priority")
    expect(seen[0]?.text).toContain("Checkout fails")
    expect(seen[0]?.text).not.toContain("someone@example.com")
    // The audit keeps the row; the server's own kinds do not list it, so it reads back `unknown`, and
    // the registry that asked it still explains it.
    const [row] = service.decisions()
    expect(row).toMatchObject({ id: "priority:issue-1", kind: "unknown", raw: { kind: "priority" }, source: "model" })
    expect(service.explain("priority:issue-1")?.question).toBe("Is this issue high priority?")
    repository.close()
  })

  test("the server's kinds answer unchanged beside the added one", async () => {
    const { service, repository } = serviceWith(recordingModel().model, {})
    const result = await service.predict({
      kind: "failure",
      state: { repeatedCalls: 4, repeatedErrors: 0, stepsUsed: 1 },
      policy: { ...DEFAULT_DECISION_POLICY, repeatedCalls: 3 },
    })
    expect(result).toMatchObject({ answer: { verdict: "intervene" }, baselineRule: "repeated-calls" })
    repository.close()
  })

  test("a model whose capabilities do not cover the kind is not asked", async () => {
    const { model, seen } = recordingModel({ capabilities: ["rank"] })
    const { service, repository } = serviceWith(model, { priority: "toy-model" })
    expect(await service.predict(toyRequest)).toMatchObject({ source: "baseline", degraded: false })
    expect(seen).toEqual([])
    repository.close()
  })

  test("the type checker rejects a kind without a baseline", () => {
    // @ts-expect-error `baseline` is required: a kind cannot exist without its deterministic answer.
    const missing = defineDecision<"noBaseline", { n: number }, { ok: boolean }>({
      kind: "noBaseline",
      capability: "classify",
      latencyClass: "batch",
      question: "?",
      probabilities: "distribution",
      questions: () => [],
      read: () => undefined,
      egress: (state) => state,
    })
    expect(missing.kind).toBe("noBaseline")
  })
})
