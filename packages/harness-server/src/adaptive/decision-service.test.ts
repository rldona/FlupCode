import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY } from "./decision"
import type { DecisionKind, DecisionRequest } from "./decision"
import { decisionID } from "./decision-record"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { createFallbackProvider } from "./providers/fallback"
import { createGovernor } from "./providers/governor"
import { DecisionUnavailable } from "./providers/provider"
import type { DecisionProvider, ProviderAnswer } from "./providers/provider"
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

/** An external provider that answers once and counts how many times it was asked. */
const spyProvider = (answer: ProviderAnswer<"completion">): DecisionProvider & { calls: number } => {
  const provider = {
    id: "fake-jev",
    calls: 0,
    async answer<Q extends DecisionKind>(): Promise<ProviderAnswer<Q>> {
      provider.calls += 1
      return answer as ProviderAnswer<Q>
    },
  }
  return provider
}

const jevOn = {
  jev: { enabled: true },
  egress: { projects: ["/work/project"], kinds: { completion: true } },
}

const serviceFor = (block: unknown, external?: DecisionProvider) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({ block, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    ...(external ? { external } : {}),
    governor,
    now: () => NOW,
  })
  return { repository, service, governor }
}

describe("the decision service (FH-015)", () => {
  test("records inputs hash, answer, confidence, provider, version, latency, degraded and fallback rule", async () => {
    const external = spyProvider({
      answer: { verdict: "complete" },
      confidence: 0.9,
      probabilities: { complete: 0.9, not_complete: 0.1 },
      modelVersion: "jev-1.13.0",
      latencyMs: 0,
    })
    const { repository, service } = serviceFor(jevOn, external)
    const request = completion()
    const result = await service.predict(request)

    expect(external.calls).toBe(1)
    expect(result.source).toBe("jev")
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
      probabilities: { complete: 0.9, not_complete: 0.1 },
      provider: "fake-jev",
      modelVersion: "jev-1.13.0",
      source: "jev",
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

  test("explain is built from the stored row and matches it, without re-running", async () => {
    const external = spyProvider({
      answer: { verdict: "complete" },
      confidence: 0.9,
      modelVersion: "jev-1.13.0",
      latencyMs: 0,
    })
    const { repository, service } = serviceFor(jevOn, external)
    await service.predict(completion())
    const explanation = service.explain("completion:episode:run:1")

    expect(explanation).toBeDefined()
    expect(explanation).toMatchObject({
      id: "completion:episode:run:1",
      source: "jev",
      provider: "fake-jev",
      modelVersion: "jev-1.13.0",
      confidence: 0.9,
      degraded: false,
      question: "Should this episode be marked complete?",
      answer: { verdict: "complete" },
      baseline: { answer: { verdict: "complete" }, rule: "episode-outcome" },
    })
    expect(explanation!.why).toContain("fake-jev")
    expect(explanation!.why).toContain("minConfidence")
    expect(explanation!.evidenceRefs).toEqual([])
    // Reading it again does not ask the provider a second time.
    service.explain("completion:episode:run:1")
    expect(external.calls).toBe(1)
    expect(service.explain("does-not-exist")).toBeUndefined()
    repository.close()
  })

  test("the DecisionPolicy thresholds gate a confident-looking answer", async () => {
    const external = spyProvider({
      answer: { verdict: "complete" },
      confidence: 0.6,
      probabilities: { complete: 0.6, not_complete: 0.4 },
      latencyMs: 0,
    })
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
    const external: DecisionProvider = {
      id: "fake-jev",
      async answer<Q extends DecisionKind>(): Promise<ProviderAnswer<Q>> {
        throw new DecisionUnavailable("network")
      },
    }
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
    const external = spyProvider({
      answer: { verdict: "complete" },
      confidence: 1,
      // The best probability is 0.6, below the 0.9 the policy demands: the confidence alone is not
      // enough, which is what keeps the thresholds in the service rather than in the adapter.
      probabilities: { complete: 0.6, not_complete: 0.4 },
      latencyMs: 0,
    })
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
    const external = spyProvider({ answer: { verdict: "complete" }, confidence: 1, latencyMs: 0 })
    const { repository, service } = serviceFor({}, external)
    const result = await service.predict(completion())

    expect(external.calls).toBe(0)
    expect(result.source).toBe("deterministic")
    expect(result.provider).toBe("deterministic")
    expect(result.degraded).toBe(false)
    expect(result.answer).toEqual(result.baseline)
    expect(repository.getDecision("completion:episode:run:1")?.source).toBe("deterministic")
    repository.close()
  })

  test("the kill switch answers deterministically and writes nothing", async () => {
    const external = spyProvider({ answer: { verdict: "complete" }, confidence: 1, latencyMs: 0 })
    const { repository, service } = serviceFor({ enabled: false, ...jevOn }, external)
    const result = await service.predict(completion())

    expect(result.source).toBe("deterministic")
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
    const down: DecisionProvider = {
      id: "jev",
      async answer<Q extends DecisionKind>(): Promise<ProviderAnswer<Q>> {
        throw new DecisionUnavailable("network")
      },
    }
    const external = createFallbackProvider({ external: down, maxAttempts: 1, now: () => NOW })
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
    const external: DecisionProvider = {
      id: "jev",
      async answer<Q extends DecisionKind>(): Promise<ProviderAnswer<Q>> {
        throw new DecisionUnavailable("rate-limited")
      },
    }
    const { repository, service, governor } = serviceFor(jevOn, external)
    const before = governor.state().concurrency
    await service.predict(completion())

    expect(governor.state().concurrency).toBeLessThan(before)
    repository.close()
  })

  test("an empty probability map and absent axes are not gates", async () => {
    const emptyMap = spyProvider({ answer: { verdict: "complete" }, confidence: 1, probabilities: {}, latencyMs: 0 })
    const empty = serviceFor(jevOn, emptyMap)
    const passed = await empty.service.predict(completion())
    expect(passed.source).toBe("jev")
    expect(passed.degraded).toBe(false)
    empty.repository.close()

    const bare = spyProvider({ answer: { verdict: "complete" }, latencyMs: 0 })
    const none = serviceFor(jevOn, bare)
    const alsoPassed = await none.service.predict(completion())
    expect(alsoPassed.source).toBe("jev")
    expect(alsoPassed.degraded).toBe(false)
    none.repository.close()
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
        items: [{ id: `command:${CANARY}`, kind: "command", tokens: 0, referenced: true }],
      },
    })

    const stored = repository.getDecision(decisionID("contextItem", "episode:raw"))!
    expect(JSON.stringify(stored)).not.toContain(CANARY)
    expect(JSON.stringify(stored!.answer)).toContain("[REDACTED]")
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
