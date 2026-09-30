import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import { DECISION_KINDS, DEFAULT_DECISION_POLICY, E2_KINDS, decisionKinds, isE2Kind } from "../decision"
import type { DecisionRequest } from "../decision"
import { createDecisionService } from "../decision-service"
import { createAdaptiveEgressGuard } from "../egress"
import { deterministicBaseline } from "../providers/deterministic"
import { createGovernor } from "../providers/governor"
import { createJevModel } from "../providers/jev"
import type { JevAnswer } from "../providers/jev-parse"
import type { Answer, PredictiveModel } from "../predictive/model"
import { questionID, questionsFor, readAnswers } from "../questions"
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

/** A model that answers the reflection's questions in order: reusable, intent, target. */
const modelAnswering = (answers: Answer[]): PredictiveModel => ({
  id: "jev",
  locality: "remote",
  supports: ["skillReflection"],
  predict: async (_state, questions) => ({
    answers: Object.fromEntries(questions.flatMap((question, index) => (answers[index] ? [[question.id, answers[index]]] : []))),
    latencyMs: 0,
    usage: { inputTokens: 0, costUsd: 0 },
    model: { id: "jev" },
  }),
})

const serviceFor = (block: Record<string, unknown>, external?: PredictiveModel) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = resolveAdaptiveConfig({ block, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: () => config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    ...(external ? { models: [external] } : {}),
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
    expect(planned[1]).toMatchObject({ type: "choice", options: ["add", "patch", "merge", "drop"] })

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
      // A likely-reusable gate with an intent the model is unsure of: the weakest axis is 0.2.
      modelAnswering([{ probabilities: { yes: 0.8, no: 0.2 } }, { probabilities: {}, choice: "add", confidence: 0.2 }]),
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
      modelAnswering([
        { probabilities: { yes: 0.9, no: 0.1 } },
        { probabilities: {}, choice: "patch", confidence: 0.9 },
        { probabilities: {}, choice: "testing" },
      ]),
    )

    const result = await service.predict(reflection())
    expect(result.source).toBe("jev")
    expect(result.answer).toEqual({ reusable: true, intent: "patch", target: "testing" })
    repository.close()
  })

  test("the Jev round trip reads the gate, the intent and the target", async () => {
    const wire: JevAnswer[] = [
      { type: "noul", probability: 0.8 },
      { type: "choice", choice: "patch", probabilities: {}, confidence: 0.7 },
      { type: "choice", choice: "testing", probabilities: {}, confidence: 0.9 },
    ]
    const answers = Object.fromEntries(wire.map((answer, index) => [questionID(index), answer]))
    const model = createJevModel({
      client: {
        predictOne: async () => ({ modelVersion: "jev-1.13.0", answers, inputTokens: 1 }),
        predictMany: async () => [{ modelVersion: "jev-1.13.0", answers, inputTokens: 1 }],
      },
    })
    const planned = questionsFor(reflection())
    const prediction = await model.predict(
      { kind: "skillReflection", text: "{}" },
      planned.map((question, index) => ({ ...question, id: questionID(index) })),
      { deadlineMs: 400, signal: new AbortController().signal, mode: "batch" },
    )

    const reading = readAnswers("skillReflection", planned, prediction.answers)
    expect(reading?.answer).toEqual({ reusable: true, intent: "patch", target: "testing" })
    // The adapter reports the intent's confidence and the gate's p(yes); the service keeps the weakest
    // of the intent and the gate's certainty (here 0.7) as the confidence it gates on.
    expect(reading?.confidence).toBe(0.7)
    expect(reading?.probabilities).toEqual({ reusable: 0.8 })
  })
})
