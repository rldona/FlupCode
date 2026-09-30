import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import { DECISION_KINDS, DEFAULT_DECISION_POLICY, E2_KINDS, decisionKinds, isE2Kind } from "../decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { createDecisionService } from "../decision-service"
import { createAdaptiveEgressGuard } from "../egress"
import { deterministicBaseline } from "../providers/deterministic"
import { createGovernor } from "../providers/governor"
import { createJevProvider } from "../providers/jev"
import type { JevPrediction } from "../providers/jev-parse"
import type { DecisionProvider, ProviderAnswer } from "../providers/provider"
import { questionsFor } from "../questions"
import { SqliteRoutineRepository } from "../../repository"

const NOW = 1_700_000_000_000

const reflection = (): DecisionRequest<"skillReflection"> => ({
  kind: "skillReflection",
  episodeID: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    episodeID: "episode:run:1",
    objective: "fix the failing test",
    outcome: "success",
    toolCalls: 3,
    signals: ["verify:test ok"],
    skills: [{ name: "testing", description: "write focused tests", learned: false }],
  },
})

const providerFor = (answer: DecisionSpec["skillReflection"]["answer"], confidence: number): DecisionProvider => ({
  id: "fake-jev",
  async answer<Q extends DecisionKind>(): Promise<ProviderAnswer<Q>> {
    return { answer: answer as DecisionSpec[Q]["answer"], confidence, probabilities: { reusable: confidence }, latencyMs: 0 }
  },
})

const serviceFor = (block: Record<string, unknown>, external?: DecisionProvider) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({ block, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: () => config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    ...(external ? { external } : {}),
    governor,
    now: () => NOW,
  })
  return { repository, service, config }
}

describe("the skillReflection kind (FH-031)", () => {
  test("is registered in every exhaustive map, and does not join E2", () => {
    expect(decisionKinds()).toContain("skillReflection")
    expect(Object.keys(DECISION_KINDS)).toEqual(decisionKinds())
    expect(decisionKinds()).toHaveLength(8)
    expect(E2_KINDS).toHaveLength(3)
    expect(isE2Kind("skillReflection")).toBe(false)
  })

  test("the deterministic baseline is inert: no-reflection", () => {
    const baseline = deterministicBaseline(reflection())
    expect(baseline.answer).toEqual({ reusable: false, intent: "add" })
    expect(baseline.rule).toBe("no-reflection")
  })

  test("asks reusable and intent, and target only when there is a roster", () => {
    const planned = questionsFor(reflection())
    expect(planned.map((question) => question.id)).toEqual(["reusable", "intent", "target"])
    expect(planned[1]?.choices).toEqual(["add", "patch", "merge", "drop"])

    const noRoster = questionsFor({ ...reflection(), state: { ...reflection().state, skills: [] } })
    expect(noRoster.map((question) => question.id)).toEqual(["reusable", "intent"])
  })

  test("with Jev off the answer is inert and the egress kind is off by default", async () => {
    const { repository, service, config } = serviceFor({})
    expect(config.egress.kinds.skillReflection).toBe(false)

    const result = await service.predict(reflection())
    expect(result.source).toBe("deterministic")
    expect(result.answer).toEqual({ reusable: false, intent: "add" })
    repository.close()
  })

  test("low confidence degrades to the inert baseline, so nothing is proposed", async () => {
    const { repository, service } = serviceFor(
      { jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { skillReflection: true } } },
      providerFor({ reusable: true, intent: "add" }, 0.2),
    )

    const result = await service.predict(reflection())
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("low-confidence")
    expect(result.answer.reusable).toBe(false)
    repository.close()
  })

  test("a confident classification wins and carries the intent", async () => {
    const { repository, service } = serviceFor(
      { jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { skillReflection: true } } },
      providerFor({ reusable: true, intent: "patch", target: "testing" }, 0.9),
    )

    const result = await service.predict(reflection())
    expect(result.source).toBe("jev")
    expect(result.answer).toEqual({ reusable: true, intent: "patch", target: "testing" })
    repository.close()
  })

  test("the Jev interpretation reads the gate, the intent and the target", async () => {
    const prediction: JevPrediction = {
      modelVersion: "jev-1.13.0",
      answers: {
        reusable: { type: "noul", probability: 0.8 },
        intent: { type: "choice", choice: "patch", probabilities: {}, confidence: 0.7 },
        target: { type: "choice", choice: "testing", probabilities: {}, confidence: 0.9 },
      },
    }
    const provider = createJevProvider({
      client: { predictOne: async () => prediction, predictMany: async () => [prediction] },
    })

    const answer = await provider.answer(reflection(), new AbortController().signal)
    expect(answer.answer).toEqual({ reusable: true, intent: "patch", target: "testing" })
    // The adapter reports the intent's confidence and the gate's p(yes); the service keeps the weakest
    // of the intent and the gate's certainty (here 0.7) as the confidence it gates on.
    expect(answer.confidence).toBe(0.7)
    expect(answer.probabilities).toEqual({ reusable: 0.8 })
  })
})
