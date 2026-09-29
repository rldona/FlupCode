import { describe, expect, test } from "bun:test"
import type { AnyDecisionRequest, DecisionKind, DecisionRequest, DecisionSpec } from "./decision"
import {
  DECISION_KINDS,
  DEFAULT_DECISION_POLICY,
  decisionInputsHash,
  decisionKinds,
  isDecisionKind,
  isDecisionSource,
  isE2Kind,
} from "./decision"

const request = <Q extends DecisionKind>(kind: Q, state: DecisionSpec[Q]["state"]): DecisionRequest<Q> => ({
  kind,
  state,
  policy: DEFAULT_DECISION_POLICY,
})

/** One valid request per kind, for the exhaustiveness and widening tests. */
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

describe("decision kinds", () => {
  test("decisionKinds lists exactly the kinds DecisionSpec declares", () => {
    expect(decisionKinds()).toEqual([
      "completion",
      "skillRelevance",
      "contextItem",
      "modelRoute",
      "agentRoute",
      "toolRisk",
      "failure",
      "skillReflection",
    ])
    expect(Object.keys(DECISION_KINDS)).toEqual(decisionKinds())
  })

  test("only the three rich kinds are E2", () => {
    expect(decisionKinds().filter(isE2Kind)).toEqual(["completion", "skillRelevance", "contextItem"])
  })

  test("every DecisionRequest<Q> widens to AnyDecisionRequest without loss", () => {
    // This assignment is the type test: it only compiles because each concrete DecisionRequest<Q> is
    // assignable to the distributive union, which is what makes a widening assertion sound.
    const widened: Record<DecisionKind, AnyDecisionRequest> = sampleRequests
    for (const kind of decisionKinds()) {
      expect(widened[kind]).toBe(sampleRequests[kind])
    }
  })
})

describe("defensive reading", () => {
  test("isDecisionKind accepts only own kinds", () => {
    expect(isDecisionKind("completion")).toBe(true)
    expect(isDecisionKind("nope")).toBe(false)
    expect(isDecisionKind(7)).toBe(false)
    expect(isDecisionKind(undefined)).toBe(false)
    // Inherited object members are not kinds.
    expect(isDecisionKind("hasOwnProperty")).toBe(false)
    expect(isDecisionKind("toString")).toBe(false)
  })

  test("isDecisionSource accepts the three sources only", () => {
    expect(["deterministic", "jev", "fallback"].every(isDecisionSource)).toBe(true)
    expect(isDecisionSource("other")).toBe(false)
    expect(isDecisionSource(undefined)).toBe(false)
  })
})

describe("decisionInputsHash", () => {
  test("is deterministic and changes with kind or state", () => {
    const first = decisionInputsHash("completion", "{}")
    expect(decisionInputsHash("completion", "{}")).toBe(first)
    expect(decisionInputsHash("skillRelevance", "{}")).not.toBe(first)
    expect(decisionInputsHash("completion", '{"a":1}')).not.toBe(first)
  })
})
