import { describe, expect, test } from "bun:test"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "../decision"
import { createDeterministicProvider, deterministicBaseline } from "./deterministic"
import { DecisionUnavailable, nullProvider } from "./provider"

const request = <Q extends DecisionKind>(kind: Q, state: DecisionSpec[Q]["state"]): DecisionRequest<Q> => ({
  kind,
  state,
  policy: DEFAULT_DECISION_POLICY,
})

const sampleRequests: { [Q in DecisionKind]: DecisionRequest<Q> } = {
  completion: request("completion", {
    episodeID: "episode:1",
    objective: "fix the failing test",
    outcome: "success",
    toolCalls: 3,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  }),
  skillRelevance: request("skillRelevance", {
    sessionID: "session-1",
    objective: "fix the failing test",
    skills: [{ name: "testing", description: "write focused tests", learned: false }],
  }),
  contextItem: request("contextItem", {
    objective: "fix the failing test",
    items: [{ id: "item-1", kind: "file", tokens: 120, referenced: true, anchors: 0, archived: false }],
  }),
  modelRoute: request("modelRoute", { role: "build", taskName: "task-1", declared: "HIGH" }),
  agentRoute: request("agentRoute", { objective: "fix the failing test", signals: ["red-check"] }),
  toolRisk: request("toolRisk", { tool: "bash", argsDigest: "abc123" }),
  failure: request("failure", { repeatedCalls: 0, repeatedErrors: 0, stepsUsed: 1 }),
  skillReflection: request("skillReflection", {
    episodeID: "episode:1",
    objective: "fix the failing test",
    outcome: "success",
    toolCalls: 3,
    signals: ["verify:test ok"],
    skills: [{ name: "testing", description: "write focused tests", learned: false }],
  }),
}

const signal = new AbortController().signal

describe("the deterministic provider", () => {
  test("answers every kind with Jev off", async () => {
    const provider = createDeterministicProvider(() => 1_000)
    const answers = await Promise.all(decisionKinds().map((kind) => provider.answer(sampleRequests[kind], signal)))
    for (const answer of answers) {
      expect(answer.answer).toBeDefined()
      expect(answer.latencyMs).toBe(0)
    }
    expect(provider.id).toBe("deterministic")
  })

  test("matches the pure baseline for every kind", async () => {
    const provider = createDeterministicProvider()
    for (const kind of decisionKinds()) {
      const baseline = deterministicBaseline(sampleRequests[kind])
      const answer = await provider.answer(sampleRequests[kind], signal)
      expect(answer.answer).toEqual(baseline.answer)
      expect(baseline.rule.length).toBeGreaterThan(0)
    }
  })

  test("is deterministic: the same request answers the same twice, for every kind", async () => {
    const provider = createDeterministicProvider(() => 1_000)
    for (const kind of decisionKinds()) {
      const first = await provider.answer(sampleRequests[kind], signal)
      const second = await provider.answer(sampleRequests[kind], signal)
      expect(second.answer).toEqual(first.answer)
      expect(first.latencyMs).toBe(0)
    }
  })

  test("does not apply the request thresholds", async () => {
    const provider = createDeterministicProvider()
    const request = sampleRequests.completion
    const strict: DecisionRequest<"completion"> = {
      ...request,
      policy: { allowJev: false, minConfidence: 1, minProbability: 1, timeoutMs: 1 },
    }
    const answer = await provider.answer(strict, signal)
    // A provider that applied thresholds would withhold an answer or mark it degraded; this seam
    // returns the raw answer and nothing else.
    expect(answer.answer).toEqual({ verdict: "complete" })
    expect(Object.keys(answer).sort()).toEqual(["answer", "latencyMs"])
  })
})

describe("the null provider", () => {
  test("occupies the external slot with a stable id", () => {
    expect(nullProvider.id).toBe("null")
  })

  test("rejects with the typed provider-disabled reason", async () => {
    const failure = await nullProvider.answer(sampleRequests.completion, signal).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "provider-disabled" })
  })
})
