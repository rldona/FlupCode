import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionRequest } from "./decision"
import { createEgressGuard } from "./egress"

const CANARY = "canary-secret-value-1234567890"

const configFor = (block: unknown) => resolveAdaptiveConfig({ block, env: {} })

const completionRequest: DecisionRequest<"completion"> = {
  kind: "completion",
  policy: DEFAULT_DECISION_POLICY,
  episodeID: "episode:1",
  projectID: "/work/project",
  state: {
    episodeID: "episode:1",
    objective: `finish ${CANARY}`,
    outcome: "success",
    toolCalls: 2,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  },
}

describe("EgressGuard.allows", () => {
  test("nothing leaves by default, for any kind or project", () => {
    const guard = createEgressGuard({ config: () => configFor({}) })
    for (const kind of decisionKinds()) {
      expect(guard.allows(kind, "/work/project")).toBe(false)
      expect(guard.allows(kind, undefined)).toBe(false)
    }
  })

  test("requires the global switch, the project list and the kind allowlist together", () => {
    const globalOnly = createEgressGuard({ config: () => configFor({ jev: { enabled: true } }) })
    expect(globalOnly.allows("completion", "/work/project")).toBe(false)

    const projectButNoKind = createEgressGuard({
      config: () => configFor({ jev: { enabled: true }, egress: { projects: ["/work/project"] } }),
    })
    expect(projectButNoKind.allows("completion", "/work/project")).toBe(false)

    const allowed = createEgressGuard({
      config: () =>
        configFor({
          jev: { enabled: true },
          egress: { projects: ["/work/project"], kinds: { completion: true } },
        }),
    })
    expect(allowed.allows("completion", "/work/project")).toBe(true)
    expect(allowed.allows("completion", "/other/project")).toBe(false)
    expect(allowed.allows("skillRelevance", "/work/project")).toBe(false)
    expect(allowed.allows("completion", undefined)).toBe(false)
  })

  test("the global switch off keeps everything in, even with project and kind listed", () => {
    const guard = createEgressGuard({
      config: () => configFor({ egress: { projects: ["/work/project"], kinds: { completion: true } } }),
    })
    expect(guard.allows("completion", "/work/project")).toBe(false)
  })
})

describe("EgressGuard.prepare", () => {
  test("a canary never appears in the model input or the summary", () => {
    const guard = createEgressGuard({ config: () => configFor({}), secrets: () => [CANARY] })
    const prepared = guard.prepare(completionRequest)
    expect(prepared.serialized).not.toContain(CANARY)
    expect(prepared.serialized).toContain("[REDACTED]")
    expect(prepared.state.text).not.toContain(CANARY)
    expect(JSON.stringify(prepared.summary)).not.toContain(CANARY)
  })

  test("bounds the whole input, questions included, to the configured budget", () => {
    const guard = createEgressGuard({
      config: () => configFor({ jev: { enabled: true, maxInputTokens: 200 } }),
    })
    const long = { ...completionRequest, state: { ...completionRequest.state, objective: "x".repeat(2_000) } }
    const prepared = guard.prepare(long)
    expect(prepared.serialized.length).toBeLessThanOrEqual(200)
    expect(prepared.serialized.length).toBeLessThan(JSON.stringify(long.state).length)
    // The input stays complete: state plus the question that carries its own prompt.
    expect(prepared.serialized).toContain('"questions":[{"id":"q0","type":"binary","prompt":"Is this episode complete?')
    expect(prepared.serialized).toBe(JSON.stringify({ state: prepared.state.text, questions: prepared.questions }))
  })

  test("the questions are part of the input and their prompts are redacted", () => {
    const guard = createEgressGuard({ config: () => configFor({}), secrets: () => [CANARY] })
    const questions = [{ id: `skill-${CANARY}`, type: "binary" as const, prompt: `Load the skill for ${CANARY}` }]
    const prepared = guard.prepare(completionRequest, questions)
    expect(prepared.serialized).not.toContain(CANARY)
    expect(prepared.serialized).toContain("[REDACTED]")
    // The id a model sees is positional, so a canary in the caller's id never reaches any model.
    expect(prepared.questions).toEqual([{ id: "q0", type: "binary", prompt: "Load the skill for [REDACTED]" }])
    expect(prepared.serialized).toContain(
      '"questions":[{"id":"q0","type":"binary","prompt":"Load the skill for [REDACTED]"}]',
    )
  })

  test("produces a stable hash for a stable question", () => {
    const guard = createEgressGuard({ config: () => configFor({}) })
    const first = guard.prepare(completionRequest)
    const second = guard.prepare(completionRequest)
    expect(first.hash).toBe(second.hash)
    expect(first.summary.digest).toBe(first.hash)
    expect(guard.prepare({ ...completionRequest, state: { ...completionRequest.state, toolCalls: 9 } }).hash).not.toBe(
      first.hash,
    )
  })
})

describe("EgressGuard.redact", () => {
  test("sweeps every string of a value, nested, with the same secrets as prepare", () => {
    const guard = createEgressGuard({ config: () => configFor({}), secrets: () => [CANARY] })
    const redacted = JSON.stringify(
      guard.redact({
        decisions: [{ id: `command:${CANARY}`, disposition: "keep" }],
        note: `Authorization: Bearer ${CANARY}`,
        count: 3,
      }),
    )
    expect(redacted).not.toContain(CANARY)
    expect(redacted).toContain("[REDACTED]")
    expect(redacted).toContain("command:")
  })
})
