import { describe, expect, test } from "bun:test"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "../decision"
import { deterministicBaseline } from "./deterministic"
import { DecisionUnavailable, degradedReasonOf } from "./provider"

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

describe("the deterministic baseline", () => {
  test("answers every kind with no model, each with the rule that produced it", () => {
    for (const kind of decisionKinds()) {
      const baseline = deterministicBaseline(sampleRequests[kind])
      expect(baseline.answer).toBeDefined()
      expect(baseline.rule.length).toBeGreaterThan(0)
    }
  })

  test("is deterministic: the same request answers the same twice, for every kind", () => {
    for (const kind of decisionKinds()) {
      expect(deterministicBaseline(sampleRequests[kind])).toEqual(deterministicBaseline(sampleRequests[kind]))
    }
  })

  test("does not apply the request thresholds", () => {
    const strict: DecisionRequest<"completion"> = {
      ...sampleRequests.completion,
      policy: { allowJev: false, minConfidence: 1, minProbability: 1, timeoutMs: 1 },
    }
    // A baseline that applied thresholds would withhold an answer or mark it degraded; it returns the
    // answer and its rule, nothing else.
    const baseline = deterministicBaseline(strict)
    expect(baseline.answer).toEqual({ verdict: "complete" })
    expect(Object.keys(baseline).sort()).toEqual(["answer", "rule"])
  })
})

describe("the reason a failure degrades with", () => {
  test("a typed failure keeps its reason; an aborted deadline is a timeout; anything else is network", () => {
    expect(degradedReasonOf(new DecisionUnavailable("provider-disabled"))).toBe("provider-disabled")
    const aborted = new Error("deadline")
    aborted.name = "AbortError"
    expect(degradedReasonOf(aborted)).toBe("timeout")
    expect(degradedReasonOf(new Error("down"))).toBe("network")
  })
})
