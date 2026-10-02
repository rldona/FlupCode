import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionKind, DecisionRequest } from "./decision"
import { decisionID } from "./decision-record"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import type { Answer, PredictOptions, Prediction, PredictiveModel, Question } from "./predictive/model"
import { createRetryingModel } from "./providers/retry"
import { createGovernor } from "./providers/governor"
import { createJevModel } from "./providers/jev"
import type { JevAnswer } from "./providers/jev-parse"
import { DecisionUnavailable } from "./providers/provider"
import { SqliteRoutineRepository } from "../repository"

const NOW = 1_700_000_000_000

const completion = (objective = "fix the failing test"): DecisionRequest<"completion"> => ({
  kind: "completion",
  episodeID: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    episodeID: "episode:run:1",
    objective,
    outcome: "success",
    toolCalls: 3,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  },
})

const contextItem = (): DecisionRequest<"contextItem"> => ({
  kind: "contextItem",
  sessionID: "ses_1",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    objective: "fix the failing test",
    items: [{ id: "message:1", kind: "message", tokens: 50, referenced: false, anchors: 0, archived: false }],
  },
})

/** A neutral prediction that gives every question asked the same answer. */
const predictionFor = (questions: readonly Question[], answer: Answer, version?: string): Prediction => ({
  answers: Object.fromEntries(questions.map((question) => [question.id, answer])),
  latencyMs: 0,
  usage: { inputTokens: 0, costUsd: 0 },
  model: { id: "jev", ...(version !== undefined ? { version } : {}) },
})

/** A predictive model whose every call runs `predict`, registered under the legacy `jev` id. */
const fakeModel = (
  predict: (questions: readonly Question[], options: PredictOptions) => Promise<Prediction>,
): PredictiveModel => ({
  id: "jev",
  locality: "remote",
  supports: decisionKinds(),
  predict: (_state, questions, options) => predict(questions, options),
})

/** A model that answers every question the same way and counts how many times it was asked. */
const spyModel = (answer: Answer, version?: string): PredictiveModel & { calls: number } => {
  const model = {
    ...fakeModel(async (questions) => {
      model.calls += 1
      return predictionFor(questions, answer, version)
    }),
    calls: 0,
  }
  return model
}

/** A model that always fails with `error`. */
const failingModel = (error: unknown): PredictiveModel => fakeModel(async () => Promise.reject(error))

const jevOn = {
  jev: { enabled: true },
  egress: { projects: ["/work/project"], kinds: { completion: true } },
}

const serviceFor = (block: unknown, model?: PredictiveModel) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({ block, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: () => config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    ...(model ? { models: [model] } : {}),
    governor,
    now: () => NOW,
  })
  return { repository, service, governor }
}

describe("the decision service (FH-015)", () => {
  test("records inputs hash, answer, confidence, provider, version, latency, degraded and fallback rule", async () => {
    const external = spyModel({ probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 }, "jev-1.13.0")
    const { repository, service } = serviceFor(jevOn, external)
    const request = completion()
    const result = await service.predict(request)

    expect(external.calls).toBe(1)
    expect(result.source).toBe("model")
    expect(result.degraded).toBe(false)

    const stored = repository.getDecision(decisionID("completion", "episode:run:1"))
    expect(stored).toBeDefined()
    expect(stored).toMatchObject({
      id: "completion:episode:run:1",
      kind: "completion",
      sessionID: "ses_1",
      episodeID: "episode:run:1",
      projectID: "/work/project",
      baselineRule: "episode-outcome",
      baselineAnswer: { verdict: "complete" },
      answer: { verdict: "complete" },
      confidence: 0.9,
      probabilities: { complete: 0.9, not_complete: 1 - 0.9 },
      provider: "jev",
      modelVersion: "jev-1.13.0",
      source: "model",
      degraded: false,
      shadow: true,
    })
    expect(stored!.inputsHash).toBe(result.inputsHash)
    expect(stored!.inputsHash).toHaveLength(64)
    expect(stored!.latencyMs).toBe(0)
    // The summary is a redacted shape, never the raw state: the objective text is not in it.
    expect(JSON.stringify(stored!.stateSummary)).not.toContain("fix the failing test")
    expect(stored!.createdAt).toBe(NOW)
    repository.close()
  })

  test("the shadow flag defaults to true and an acting call can write shadow false", async () => {
    const { repository, service } = serviceFor({})
    await service.predict(completion())
    expect(repository.getDecision("completion:episode:run:1")?.shadow).toBe(true)

    const acting = { ...completion(), scopeID: "ses_1:msg_1" }
    await service.predict(acting, "hot", false)
    expect(repository.getDecision(decisionID("completion", "ses_1:msg_1"))?.shadow).toBe(false)
    repository.close()
  })

  test("explain is built from the stored row and matches it, without re-running", async () => {
    const external = spyModel({ probabilities: { yes: 0.9, no: 0.1 } }, "jev-1.13.0")
    const { repository, service } = serviceFor(jevOn, external)
    await service.predict(completion())
    const explanation = service.explain("completion:episode:run:1")

    expect(explanation).toBeDefined()
    expect(explanation).toMatchObject({
      id: "completion:episode:run:1",
      source: "model",
      provider: "jev",
      modelVersion: "jev-1.13.0",
      confidence: 0.9,
      degraded: false,
      question: "Should this episode be marked complete?",
      answer: { verdict: "complete" },
      baseline: { answer: { verdict: "complete" }, rule: "episode-outcome" },
    })
    expect(explanation!.why).toContain("jev jev-1.13.0 answered")
    expect(explanation!.why).toContain("minConfidence")
    expect(explanation!.evidenceRefs).toEqual([])
    // Reading it again does not ask the provider a second time.
    service.explain("completion:episode:run:1")
    expect(external.calls).toBe(1)
    expect(service.explain("does-not-exist")).toBeUndefined()
    repository.close()
  })

  test("the DecisionPolicy thresholds gate a confident-looking answer", async () => {
    const external = spyModel({ probabilities: { yes: 0.6, no: 0.4 }, confidence: 0.6 })
    const { repository, service } = serviceFor(jevOn, external)
    // The thresholds live in the request's policy, which is what the caller (the shadow) sets from
    // the config; the service applies them to whatever the provider returned.
    const result = await service.predict({
      ...completion(),
      policy: { ...DEFAULT_DECISION_POLICY, minConfidence: 0.95 },
    })

    expect(result.source).toBe("fallback")
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("low-confidence")
    // The fallback answer equals the deterministic baseline byte for byte.
    expect(result.answer).toEqual(result.baseline)
    expect(repository.getDecision("completion:episode:run:1")?.degradedReason).toBe("low-confidence")
    repository.close()
  })

  test("a provider failure degrades to the deterministic answer and records the reason", async () => {
    const external = failingModel(new DecisionUnavailable("network"))
    const { repository, service } = serviceFor(jevOn, external)
    const result = await service.predict(completion())

    expect(result.source).toBe("fallback")
    expect(result.provider).toBe("deterministic")
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("network")
    // The degraded answer is the deterministic baseline byte for byte.
    expect(result.answer).toEqual(result.baseline)
    expect(repository.getDecision("completion:episode:run:1")).toMatchObject({
      source: "fallback",
      provider: "deterministic",
      degraded: true,
      degradedReason: "network",
    })
    repository.close()
  })

  test("the probability axis of the policy gates an otherwise confident answer", async () => {
    // The best probability is 0.6, below the 0.9 the policy demands: the confidence alone is not
    // enough, which is what keeps the thresholds in the service rather than in the adapter.
    const external = spyModel({ probabilities: { yes: 0.6, no: 0.4 }, confidence: 1 })
    const { repository, service } = serviceFor(jevOn, external)
    const result = await service.predict({
      ...completion(),
      policy: { ...DEFAULT_DECISION_POLICY, minProbability: 0.9 },
    })

    expect(result.source).toBe("fallback")
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("low-confidence")
    repository.close()
  })

  test("never persists raw state: a canary is nowhere in the stored row", async () => {
    const CANARY = "canary-secret-value-1234567890"
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const egress = createAdaptiveEgressGuard({ config: () => config, secrets: () => [CANARY] })
    const service = createDecisionService({ repository, config: () => config, egress, now: () => NOW })
    await service.predict({ ...completion(`finish ${CANARY}`), episodeID: "episode:canary" })

    const stored = repository.getDecision(decisionID("completion", "episode:canary"))
    expect(stored).toBeDefined()
    // The audit keeps a redacted summary: the objective text never reaches a column.
    expect(JSON.stringify(stored)).not.toContain(CANARY)
    repository.close()
  })

  test("with Jev off it is deterministic and nothing is asked of the provider or the egress", async () => {
    const external = spyModel({ probabilities: { yes: 1, no: 0 } })
    const { repository, service } = serviceFor({}, external)
    const result = await service.predict(completion())

    expect(external.calls).toBe(0)
    expect(result.source).toBe("baseline")
    expect(result.provider).toBe("deterministic")
    expect(result.degraded).toBe(false)
    expect(result.answer).toEqual(result.baseline)
    expect(repository.getDecision("completion:episode:run:1")?.source).toBe("baseline")
    repository.close()
  })

  test("the kill switch answers deterministically and writes nothing", async () => {
    const external = spyModel({ probabilities: { yes: 1, no: 0 } })
    const { repository, service } = serviceFor({ enabled: false, ...jevOn }, external)
    const result = await service.predict(completion())

    expect(result.source).toBe("baseline")
    expect(external.calls).toBe(0)
    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })

  test("listing filters by episode and kind, newest first", async () => {
    const { repository, service } = serviceFor({})
    await service.predict(completion("one"))
    await service.predict({ ...completion("two"), episodeID: "episode:run:2" })
    expect(service.decisions({ episodeID: "episode:run:1" })).toHaveLength(1)
    expect(service.decisions({ kind: "completion" })).toHaveLength(2)
    expect(service.decisions({ kind: "skillRelevance" })).toHaveLength(0)
    repository.close()
  })

  test("a wired fallback is honored: a down Jev is recorded degraded with its attempted provider", async () => {
    const external = createRetryingModel({ model: failingModel(new DecisionUnavailable("network")), maxAttempts: 1 })
    const { repository, service } = serviceFor(jevOn, external)
    const result = await service.predict(completion())

    expect(result.source).toBe("fallback")
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("network")
    const stored = repository.getDecision("completion:episode:run:1")!
    expect(stored).toMatchObject({
      source: "fallback",
      provider: "deterministic",
      attemptedProvider: "jev",
      degraded: true,
      degradedReason: "network",
    })
    // `explain` names the provider that was asked, not the deterministic rule that answered.
    const explanation = service.explain("completion:episode:run:1")!
    expect(explanation.attemptedProvider).toBe("jev")
    expect(explanation.why).toContain("jev")
    repository.close()
  })

  test("a 429 without Retry-After still reduces the limiter concurrency", async () => {
    const external = failingModel(new DecisionUnavailable("rate-limited"))
    const { repository, service, governor } = serviceFor(jevOn, external)
    const before = governor.state().concurrency
    await service.predict(completion())

    expect(governor.state().concurrency).toBeLessThan(before)
    repository.close()
  })

  test("an empty probability map is not a gate", async () => {
    // A choice the model named outright, with no distribution behind it, is judged on its confidence.
    const contextOn = { jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { contextItem: true } } }
    const emptyMap = spyModel({ probabilities: {}, choice: "archive", confidence: 1 })
    const empty = serviceFor(contextOn, emptyMap)
    const passed = await empty.service.predict(contextItem())
    expect(passed).toMatchObject({ source: "model", degraded: false, answer: { decisions: [{ id: "message:1", disposition: "archive" }] } })
    empty.repository.close()
  })

  test("never persists an answer echoing raw content: the writer redacts before the row", async () => {
    const CANARY = "canary-secret-value-1234567890"
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const egress = createAdaptiveEgressGuard({ config: () => config, secrets: () => [CANARY] })
    const service = createDecisionService({ repository, config: () => config, egress, now: () => NOW })
    // The deterministic context answer mirrors the item ids; an id carrying a secret must not land.
    await service.predict({
      kind: "contextItem",
      episodeID: "episode:raw",
      projectID: "/work/project",
      policy: config.decisions.contextItem,
      state: {
        objective: "clean",
        items: [{ id: `command:${CANARY}`, kind: "command", tokens: 0, referenced: true, anchors: 0, archived: false }],
      },
    })

    const stored = repository.getDecision(decisionID("contextItem", "episode:raw"))!
    expect(JSON.stringify(stored)).not.toContain(CANARY)
    expect(JSON.stringify(stored!.answer)).toContain("[REDACTED]")
    repository.close()
  })

  test("a hot prediction is not queued behind a saturated batch limiter", async () => {
    const external = spyModel({ probabilities: { yes: 1, no: 0 } })
    const { repository, service, governor } = serviceFor(
      { ...jevOn, governor: { limiter: { initial: 1, max: 1, min: 1, restoreEvery: 8 } } },
      external,
    )
    // Hold the only batch slot: the hot entry must bypass the limiter entirely (ADR-0017 §4).
    let acquired: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      acquired = resolve
    })
    void governor.runBatch("held", 1, () => {
      acquired()
      return new Promise<void>(() => {})
    })
    await held

    const result = await service.predict(completion(), "hot")
    expect(result.source).toBe("model")
    expect(external.calls).toBe(1)
    repository.close()
  })

  test("the hot path's own deadline aborts a hung provider; a batch call is not bounded by it", async () => {
    // A provider that only settles when the signal aborts: this is the hang the hot deadline exists
    // to cut, and it makes the `timeout` reason observable instead of a `network` one.
    const hung = fakeModel(
      (_questions, options) =>
        new Promise<Prediction>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("deadline")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )
    const policy = { ...DEFAULT_DECISION_POLICY, timeoutMs: 10 }
    const hot = serviceFor(jevOn, hung)
    const timedOut = await hot.service.predict({ ...completion(), policy }, "hot")
    expect(timedOut.degraded).toBe(true)
    expect(timedOut.degradedReason).toBe("timeout")
    hot.repository.close()

    // The deadline belongs to the hot path alone: the same short `timeoutMs` does not bound a batch
    // call, so the slow provider finishes un-aborted even past the deadline (ADR-0017 §4).
    const bounded = { aborted: true }
    const slow = fakeModel(async (questions, options) => {
      await Bun.sleep(30)
      bounded.aborted = options.signal.aborted
      return predictionFor(questions, { probabilities: { yes: 1, no: 0 } })
    })
    const batch = serviceFor(jevOn, slow)
    const answered = await batch.service.predict({ ...completion(), policy })
    expect(answered.source).toBe("model")
    expect(bounded.aborted).toBe(false)
    batch.repository.close()
  })

  test("a hot 429 with Retry-After: 30 returns the baseline within the hot timeout (AH-A06)", async () => {
    let calls = 0
    const limited = fakeModel(async () => {
      calls += 1
      throw new DecisionUnavailable("rate-limited", { retryAfterMs: 30_000 })
    })
    // The production wiring: real sleep, default attempts and delays.
    const external = createRetryingModel({ model: limited })
    const { repository, service } = serviceFor(jevOn, external)
    const startedAt = Date.now()
    const result = await service.predict(completion(), "hot")

    expect(Date.now() - startedAt).toBeLessThan(DEFAULT_DECISION_POLICY.timeoutMs)
    expect(calls).toBe(1)
    expect(result).toMatchObject({ source: "fallback", degraded: true, degradedReason: "rate-limited" })
    repository.close()
  })

  test("five concurrent identical predictions that fail share one breaker failure (AH-A06)", async () => {
    let calls = 0
    const down = fakeModel(async () => {
      calls += 1
      await Promise.resolve()
      throw new DecisionUnavailable("timeout")
    })
    const external = createRetryingModel({ model: down, maxAttempts: 1 })
    const { repository, service, governor } = serviceFor({ ...jevOn, governor: { breakerFailures: 2 } }, external)
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => service.predict(completion(), "hot")))

    expect(calls).toBe(1)
    expect(results.every((result) => result.degradedReason === "timeout")).toBe(true)
    // Five per-caller recordings would have opened a threshold of two.
    expect(governor.state().breaker).toBe("closed")
    repository.close()
  })

  test("a corrupt audit row decodes defensively instead of taking the endpoint down", () => {
    const { repository, service } = serviceFor({})
    repository.db.exec(
      `INSERT INTO adaptive_decision
        (id, kind, inputs_hash, state_summary_json, answer_json, baseline_answer_json, baseline_rule,
         provider, source, latency_ms, policy_json, shadow, created_at, updated_at)
       VALUES ('broken', 'completion', 'h', '{not json', '{not json', '{not json', 'rule',
         'deterministic', 'deterministic', 0, '{not json', 1, 1, 1)`,
    )
    expect(() => service.decisions()).not.toThrow()
    const decisions = service.decisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.answer).toBeUndefined()
    expect(decisions[0]!.baselineAnswer).toBeUndefined()
    repository.close()
  })
})

/**
 * The real Jev adapter over canned wire answers, one per question in the order they are asked: only
 * the network boundary is faked.
 */
const jevAnswering = (answers: JevAnswer[]) => {
  const keyed = (questions: readonly Question[]) =>
    Object.fromEntries(questions.flatMap((question, index) => (answers[index] ? [[question.id, answers[index]]] : [])))
  return createJevModel({
    client: {
      predictOne: async (_state, questions) => ({
        modelVersion: "jev-1.13.0",
        answers: keyed(questions),
        inputTokens: 1,
      }),
      predictMany: async (_states, questions) => [
        { modelVersion: "jev-1.13.0", answers: keyed(questions), inputTokens: 1 },
      ],
    },
  })
}

const jevOnFor = (kind: DecisionKind) => ({
  jev: { enabled: true },
  egress: { projects: ["/work/project"], kinds: { [kind]: true } },
})

const failure = (): DecisionRequest<"failure"> => ({
  kind: "failure",
  sessionID: "ses_1",
  projectID: "/work/project",
  scopeID: "ses_1:bash:a",
  policy: DEFAULT_DECISION_POLICY,
  // Five repeated calls: the deterministic baseline says `intervene`, so a Jev `continue` is visible.
  state: { repeatedCalls: 5, repeatedErrors: 0, stepsUsed: 5 },
})

const relevance = (): DecisionRequest<"skillRelevance"> => ({
  kind: "skillRelevance",
  sessionID: "ses_1",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  // The lexical baseline loads both (they share "test" with the objective), so Jev's `[]` is visible.
  state: {
    sessionID: "ses_1",
    objective: "fix the failing test",
    skills: [
      { name: "testing", description: "write a focused test", learned: false },
      { name: "test-data", description: "seed test fixtures", learned: false },
    ],
  },
})

describe("calibrated confidence: the probability of the answer actually chosen (AH-A01)", () => {
  test("completion: a confident no wins, a confident yes wins, a coin flip degrades", async () => {
    const decide = async (probability: number) => {
      const { repository, service } = serviceFor(jevOn, jevAnswering([{ type: "noul", probability }]))
      const result = await service.predict(completion())
      repository.close()
      return result
    }

    const no = await decide(0.05)
    expect(no.baseline).toEqual({ verdict: "complete" })
    expect(no).toMatchObject({ source: "model", degraded: false, answer: { verdict: "not_complete" }, confidence: 0.95 })

    const yes = await decide(0.95)
    expect(yes).toMatchObject({ source: "model", degraded: false, answer: { verdict: "complete" }, confidence: 0.95 })

    const ambiguous = await decide(0.5)
    expect(ambiguous).toMatchObject({ source: "fallback", degraded: true, degradedReason: "low-confidence", confidence: 0.5 })
    expect(ambiguous.answer).toEqual(ambiguous.baseline)
  })

  test("failure: a confident p(intervene) = 0.05 is a `continue`, not a discarded answer", async () => {
    const decide = async (probability: number) => {
      const { repository, service } = serviceFor(jevOnFor("failure"), jevAnswering([{ type: "noul", probability }]))
      const result = await service.predict(failure())
      repository.close()
      return result
    }

    const calm = await decide(0.05)
    expect(calm.baseline).toEqual({ verdict: "intervene" })
    expect(calm).toMatchObject({ source: "model", degraded: false, answer: { verdict: "continue" }, confidence: 0.95 })

    const loop = await decide(0.9)
    expect(loop).toMatchObject({ source: "model", degraded: false, answer: { verdict: "intervene" }, confidence: 0.9 })

    const unsure = await decide(0.45)
    expect(unsure).toMatchObject({ source: "fallback", degraded: true, degradedReason: "low-confidence" })
  })

  test("skillRelevance: confidence is the least certain gate, so `load: []` can be a confident answer", async () => {
    const decide = async (testing: number, testData: number) => {
      const { repository, service } = serviceFor(
        jevOnFor("skillRelevance"),
        jevAnswering([
          { type: "noul", probability: testing },
          { type: "noul", probability: testData },
        ]),
      )
      const result = await service.predict(relevance())
      repository.close()
      return result
    }

    // Every gate a confident no: the top per-skill probability is 0.02, yet the answer is 0.98 certain.
    const none = await decide(0.02, 0.02)
    expect(none.baseline).toEqual({ load: ["testing", "test-data"] })
    expect(none).toMatchObject({ source: "model", degraded: false, answer: { load: [] }, confidence: 0.98 })

    const one = await decide(0.9, 0.02)
    expect(one).toMatchObject({ source: "model", degraded: false, answer: { load: ["testing"] }, confidence: 0.9 })

    // One gate on the fence makes the whole set ambiguous, however sure the other gate is.
    const fence = await decide(0.95, 0.5)
    expect(fence).toMatchObject({ source: "fallback", degraded: true, degradedReason: "low-confidence", confidence: 0.5 })
    expect(fence.answer).toEqual(fence.baseline)
  })

  test("a provider's own confidence still gates: the recorded confidence is the weakest axis", async () => {
    const external = spyModel({ probabilities: { yes: 0.05, no: 0.95 }, confidence: 0.55 })
    const { repository, service } = serviceFor(jevOn, external)
    const result = await service.predict(completion())

    expect(result).toMatchObject({ source: "fallback", degraded: true, degradedReason: "low-confidence", confidence: 0.55 })
    expect(repository.getDecision("completion:episode:run:1")?.confidence).toBe(0.55)
    repository.close()
  })
})

describe("the predictive model registry (AH-C01)", () => {
  /** A model under its own id that records what it was handed and answers with `answer`. */
  const registered = (
    id: string,
    locality: "local" | "remote",
    answer: (questions: readonly Question[], options: PredictOptions) => Promise<Prediction>,
    supports: readonly DecisionKind[] = decisionKinds(),
  ) => {
    const seen: Array<{ text: string; questions: readonly Question[] }> = []
    const model: PredictiveModel & { seen: typeof seen } = {
      id,
      locality,
      supports,
      seen,
      predict: (state, questions, options) => {
        seen.push({ text: state.text, questions })
        return answer(questions, options)
      },
    }
    return model
  }
  const answering =
    (answers: Record<string, Answer>, id = "fake-local") =>
    async (): Promise<Prediction> => ({
      answers,
      latencyMs: 3,
      usage: { inputTokens: 10, costUsd: 0.001 },
      model: { id, version: "v1" },
    })


  test("a binary answer: the chosen answer's probability is the confidence, and the model is audited", async () => {
    const model = registered("fake-local", "local", answering({ q0: { probabilities: { yes: 0.05, no: 0.95 } } }))
    const { repository, service } = serviceFor({ models: { completion: "fake-local" } }, model)
    const result = await service.predict(completion("finish canary-secret-value-1234567890"))

    expect(result).toMatchObject({
      source: "model",
      provider: "fake-local",
      modelVersion: "v1",
      degraded: false,
      answer: { verdict: "not_complete" },
      confidence: 0.95,
      probabilities: { complete: 0.05, not_complete: 0.95 },
      baseline: { verdict: "complete" },
    })
    // The model only ever sees neutral, positional questions and the serialized state.
    expect(model.seen[0]!.questions).toEqual([
      {
        id: "q0",
        type: "binary",
        prompt: "Is this episode complete? Objective: finish canary-secret-value-1234567890",
      },
    ])
    expect(repository.getDecision("completion:episode:run:1")).toMatchObject({
      provider: "fake-local",
      attemptedProvider: "fake-local",
      source: "model",
    })
    repository.close()
  })

  test("a choice answer: the most probable option wins when the model names none", async () => {
    const model = registered(
      "fake-local",
      "local",
      answering({ q0: { probabilities: { keep: 0.1, archive: 0.8, drop: 0.1 }, confidence: 0.8 } }),
    )
    const { repository, service } = serviceFor({ models: { contextItem: "fake-local" } }, model)
    const result = await service.predict(contextItem())

    expect(model.seen[0]!.questions[0]).toMatchObject({ id: "q0", type: "choice", options: ["keep", "archive", "drop"] })
    expect(result).toMatchObject({
      source: "model",
      degraded: false,
      answer: { decisions: [{ id: "message:1", disposition: "archive" }] },
      confidence: 0.8,
    })
    repository.close()
  })

  test("confidence is the weakest of the model's own claim and the chosen probability, and it gates", async () => {
    const claim = (confidence: number) =>
      registered("fake-local", "local", answering({ q0: { probabilities: { yes: 0.2, no: 0.8 }, confidence } }))

    const modest = serviceFor({ models: { completion: "fake-local" } }, claim(0.7))
    expect(await modest.service.predict(completion())).toMatchObject({ source: "model", confidence: 0.7 })
    modest.repository.close()

    // A model cannot talk its way past the chosen probability either: 0.99 claimed, 0.8 recorded.
    const boastful = serviceFor({ models: { completion: "fake-local" } }, claim(0.99))
    expect(await boastful.service.predict(completion())).toMatchObject({ confidence: 0.8 })
    boastful.repository.close()

    const unsure = serviceFor({ models: { completion: "fake-local" } }, claim(0.4))
    const gated = await unsure.service.predict(completion())
    expect(gated).toMatchObject({
      source: "fallback",
      degraded: true,
      degradedReason: "low-confidence",
      confidence: 0.4,
    })
    expect(gated.answer).toEqual(gated.baseline)
    unsure.repository.close()
  })

  test("a hot call past its deadline degrades to the baseline with the timeout reason", async () => {
    const hanging = registered(
      "fake-local",
      "local",
      (_questions, options) =>
        new Promise<Prediction>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason))
        }),
    )
    const { repository, service } = serviceFor({ models: { completion: "fake-local" } }, hanging)
    const startedAt = Date.now()
    const result = await service.predict(
      { ...completion(), policy: { ...DEFAULT_DECISION_POLICY, timeoutMs: 10 } },
      "hot",
    )

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      source: "fallback",
      provider: "deterministic",
      degraded: true,
      degradedReason: "timeout",
    })
    expect(result.answer).toEqual(result.baseline)
    expect(repository.getDecision("completion:episode:run:1")?.attemptedProvider).toBe("fake-local")
    repository.close()
  })

  test("a model assigned to a kind it does not support is never asked: the baseline answers", async () => {
    const model = registered("fake-local", "local", answering({}), ["completion"])
    const { repository, service } = serviceFor({ models: { failure: "fake-local" } }, model)
    const result = await service.predict(failure())

    expect(model.seen).toHaveLength(0)
    expect(result).toMatchObject({
      source: "baseline",
      provider: "deterministic",
      degraded: false,
      answer: { verdict: "intervene" },
    })
    repository.close()
  })

  test("an unregistered id, `baseline`, or a policy that forbids models keeps the baseline", async () => {
    const model = registered("fake-local", "local", answering({ q0: { probabilities: { yes: 0.9, no: 0.1 } } }))
    for (const block of [{ models: { completion: "nobody" } }, { models: { completion: "baseline" } }, {}]) {
      const { repository, service } = serviceFor(block, model)
      expect((await service.predict(completion())).source).toBe("baseline")
      repository.close()
    }
    const forbidden = serviceFor({ models: { completion: "fake-local" } }, model)
    const result = await forbidden.service.predict({
      ...completion(),
      policy: { ...DEFAULT_DECISION_POLICY, allowModel: false },
    })
    expect(result.source).toBe("baseline")
    forbidden.repository.close()
    expect(model.seen).toHaveLength(0)
  })

  test("a remote model is only asked for a project and kind its own provider's consent lets out", async () => {
    const model = registered(
      "fake-remote",
      "remote",
      answering({ q0: { probabilities: { yes: 0.9, no: 0.1 } } }, "fake-remote"),
    )
    const denied = serviceFor({ models: { completion: "fake-remote" } }, model)
    expect((await denied.service.predict(completion())).source).toBe("baseline")
    denied.repository.close()

    // Jev's consent (the legacy keys) is Jev's alone: another remote model stays unasked.
    const jevConsent = serviceFor({ ...jevOn, models: { completion: "fake-remote" } }, model)
    expect((await jevConsent.service.predict(completion())).source).toBe("baseline")
    jevConsent.repository.close()
    expect(model.seen).toHaveLength(0)

    const consent = { enabled: true, projects: ["/work/project"], kinds: { completion: true } }
    const allowed = serviceFor(
      { egress: { providers: { "fake-remote": consent } }, models: { completion: "fake-remote" } },
      model,
    )
    expect(await allowed.service.predict(completion())).toMatchObject({ source: "model", provider: "fake-remote" })
    allowed.repository.close()
    expect(model.seen).toHaveLength(1)
  })

  test("modelFor gates per provider: two remote models and one local, each under its own rule", async () => {
    const yes = { q0: { probabilities: { yes: 0.9, no: 0.1 } } }
    const jev = registered("jev", "remote", answering(yes, "jev"))
    const small = registered("small-llm", "remote", answering(yes, "small-llm"))
    const local = registered("local-embed", "local", answering(yes, "local-embed"))
    const consent = { enabled: true, projects: ["/work/project"], kinds: { completion: true, failure: true } }
    const decide = async (block: Record<string, unknown>, assigned: string) => {
      const repository = new SqliteRoutineRepository(":memory:")
      const config = resolveAdaptiveConfig({ block: { ...block, models: { completion: assigned } }, env: {} })
      const service = createDecisionService({
        repository,
        config: () => config,
        egress: createAdaptiveEgressGuard({ config: () => config }),
        models: [jev, small, local],
        governor: createGovernor({ config: () => config.governor, store: repository, now: () => NOW }),
        now: () => NOW,
      })
      const result = await service.predict(completion())
      repository.close()
      return result.provider
    }

    // Consenting to small-llm lets small-llm out and nothing else: Jev stays unasked.
    const smallOnly = { egress: { providers: { "small-llm": consent } } }
    expect(await decide(smallOnly, "small-llm")).toBe("small-llm")
    expect(await decide(smallOnly, "jev")).toBe("deterministic")
    // And the other way round.
    const jevOnly = { egress: { providers: { jev: consent } } }
    expect(await decide(jevOnly, "jev")).toBe("jev")
    expect(await decide(jevOnly, "small-llm")).toBe("deterministic")
    // A local model needs no consent at all, but the kill switch stops it.
    expect(await decide({}, "local-embed")).toBe("local-embed")
    expect(await decide({ enabled: false, ...jevOnly }, "local-embed")).toBe("deterministic")
    expect(jev.seen).toHaveLength(1)
    expect(small.seen).toHaveLength(1)
    expect(local.seen).toHaveLength(1)
  })

  test("answers that do not read as the kind's answer degrade as malformed", async () => {
    const model = registered("fake-local", "local", answering({ q0: { probabilities: { maybe: 1 } } }))
    const { repository, service } = serviceFor({ models: { completion: "fake-local" } }, model)
    expect(await service.predict(completion())).toMatchObject({
      source: "fallback",
      degraded: true,
      degradedReason: "malformed",
    })
    repository.close()
  })

  test("model ids are unique in the registry", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const model = registered("twin", "local", answering({}))
    expect(() =>
      createDecisionService({
        repository,
        config: () => config,
        egress: createAdaptiveEgressGuard({ config: () => config }),
        models: [model, model],
      }),
    ).toThrow("unique")
    repository.close()
  })
})

describe("the provider-neutral audit (AH-C02)", () => {
  /** A model that reports what the call consumed, the way a metered remote model does. */
  const meteredModel = (answer: Answer): PredictiveModel =>
    fakeModel(async (questions) => ({
      ...predictionFor(questions, answer, "small-1"),
      usage: { inputTokens: 812, costUsd: 0.0031 },
      model: { id: "small-llm", version: "small-1" },
    }))

  test("a model answer records source model with the model id, version, cost and tokens", async () => {
    const { repository, service } = serviceFor(jevOn, meteredModel({ probabilities: { yes: 0.9, no: 0.1 } }))
    await service.predict(completion())
    expect(repository.getDecision("completion:episode:run:1")).toMatchObject({
      source: "model",
      provider: "small-llm",
      providerID: "small-llm",
      providerVersion: "small-1",
      costUsd: 0.0031,
      inputTokens: 812,
    })
    const explanation = service.explain("completion:episode:run:1")!
    expect(explanation).toMatchObject({ providerID: "small-llm", costUsd: 0.0031, inputTokens: 812 })
    expect(explanation.why).toContain("small-llm small-1 answered")
    repository.close()
  })

  test("a model below the thresholds is a fallback that still records what the call cost", async () => {
    const { repository, service } = serviceFor(jevOn, meteredModel({ probabilities: { yes: 0.52, no: 0.48 } }))
    await service.predict(completion())
    expect(repository.getDecision("completion:episode:run:1")).toMatchObject({
      source: "fallback",
      provider: "deterministic",
      providerID: "small-llm",
      costUsd: 0.0031,
      inputTokens: 812,
      degradedReason: "low-confidence",
    })
    repository.close()
  })

  test("a failed call names the model it asked and leaves the cost unmeasured, not zero", async () => {
    const { repository, service } = serviceFor(jevOn, failingModel(new DecisionUnavailable("timeout")))
    await service.predict(completion())
    const stored = repository.getDecision("completion:episode:run:1")!
    expect(stored).toMatchObject({ source: "fallback", providerID: "jev" })
    expect(stored.costUsd).toBeUndefined()
    expect(stored.inputTokens).toBeUndefined()
    repository.close()
  })

  test("the baseline alone records no provider and no cost", async () => {
    const { repository, service } = serviceFor({})
    await service.predict(completion())
    const stored = repository.getDecision("completion:episode:run:1")!
    expect(stored.source).toBe("baseline")
    expect(stored.providerID).toBeUndefined()
    expect(stored.costUsd).toBeUndefined()
    expect(service.explain(stored.id)!.why).toContain("no predictive model was consulted")
    repository.close()
  })

  test("explain reads a row with an unknown kind and source instead of losing it", async () => {
    const { repository, service } = serviceFor({})
    await service.predict(completion())
    repository.db.exec("UPDATE adaptive_decision SET kind = 'future-kind', source = 'ensemble'")
    const explanation = service.explain("completion:episode:run:1")!
    expect(explanation).toMatchObject({ source: "unknown", raw: { kind: "future-kind", source: "ensemble" } })
    expect(explanation.question).toContain("future-kind")
    expect(explanation.why).toContain("ensemble")
    expect(service.decisions()).toHaveLength(1)
    repository.close()
  })
})
