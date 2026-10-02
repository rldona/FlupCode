import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./adaptive/config"
import { decisionKinds } from "./adaptive/decision"
import { createDecisionService } from "./adaptive/decision-service"
import { createAdaptiveEgressGuard } from "./adaptive/egress"
import { createGovernor } from "./adaptive/providers/governor"
import type { PredictiveModel, Question } from "./adaptive/predictive/model"
import { SqliteRoutineRepository } from "./repository"
import type { TaskVerdict } from "./types"
import { answerVerdict, auditedVerdict, createAuditor, runVerdict } from "./verdict"

// RP-06: the final answers the deterministic rule is asked about. It says what it can tell for
// certain and `unverified` for the rest — a partial job reads like a finished one to a rule.
describe("the verdict on a final answer, without a model", () => {
  test.each([
    ["success", "Renamed the parser and updated the three call sites.", "unverified", "Nothing checked this answer"],
    [
      "refusal",
      "I read the parser.\n\nI cannot do this without the vendor's API key, so I stop here.",
      "failed",
      "I cannot do this without the vendor's API key, so I stop here.",
    ],
    ["give-up", "Tried three approaches. I give up.", "failed", "I give up."],
    ["stop here", "The build needs a newer SDK. I'll stop here until it is installed.", "failed", "I'll stop here until it is installed."],
    ["refusal, Spanish", "He revisado el código. No puedo completar la tarea sin acceso a la base de datos.", "failed", "No puedo completar la tarea sin acceso a la base de datos."],
    ["stop, Spanish", "Falta la clave de la API, así que me detengo aquí.", "failed", "Falta la clave de la API, así que me detengo aquí."],
    [
      "partial",
      "I renamed the parser. Two call sites in the CLI still use the old name; I did not get to them.",
      "unverified",
      "Nothing checked this answer",
    ],
    [
      "question",
      "There are two databases configured.\n\nWhich one should the migration target, Postgres or SQLite?",
      "needs-user",
      "Which one should the migration target, Postgres or SQLite?",
    ],
    ["question, Spanish", "Hay dos ramas posibles. ¿Cuál quieres que use?", "needs-user", "¿Cuál quieres que use?"],
    ["closing offer", "Renamed the parser. Would you like me to add tests as well?", "unverified", "Nothing checked this answer"],
    ["finding, not a refusal", "I can't find any caller of the old name; the rename is complete.", "unverified", "Nothing checked this answer"],
    ["empty", "  \n ", "failed", "The agent's final answer is empty"],
  ])("%s", (_name, answer, value, reason) => {
    expect(answerVerdict(answer)).toEqual({ value: value as TaskVerdict["value"], reason, source: "rule" })
  })

  test("no answer at all is an empty one", () => {
    expect(answerVerdict(undefined).value).toBe("failed")
  })
})

describe("a run's verdict", () => {
  const verdict = (value: TaskVerdict["value"]): TaskVerdict => ({ value, reason: value, source: "rule" })

  test("is its worst task's, and names it", () => {
    expect(
      runVerdict([
        { id: "a", verdict: verdict("verified") },
        { id: "b", verdict: verdict("needs-user") },
        { id: "c", verdict: verdict("unverified") },
        { id: "d" },
      ]),
    ).toEqual({ ...verdict("needs-user"), taskID: "b" })
    expect(runVerdict([{ id: "a", verdict: verdict("needs-user") }, { id: "b", verdict: verdict("failed") }])?.taskID).toBe("b")
  })

  test("leaves out an attempt a retry superseded", () => {
    expect(
      runVerdict([
        { id: "first", verdict: verdict("failed") },
        { id: "second", retryOf: "first", verdict: verdict("verified") },
      ]),
    ).toEqual({ ...verdict("verified"), taskID: "second" })
  })

  test("is absent while nothing was judged", () => {
    expect(runVerdict([{ id: "a" }])).toBeUndefined()
  })
})

describe("the auditor model", () => {
  const PROJECT = "/work/project"

  /** A real decision service whose one model answers every question with `yes`'s probability. */
  const audited = (yes: number) => {
    const asked: Question[] = []
    const model: PredictiveModel = {
      id: "jev",
      locality: "remote",
      supports: decisionKinds(),
      predict: async (_state, questions) => {
        asked.push(...questions)
        return {
          answers: Object.fromEntries(
            questions.map((question) => [question.id, { probabilities: { yes, no: 1 - yes }, confidence: 0.9 }]),
          ),
          latencyMs: 0,
          usage: { inputTokens: 0, costUsd: 0 },
          model: { id: "jev" },
        }
      },
    }
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({
      block: { jev: { enabled: true }, egress: { projects: [PROJECT], kinds: { completion: true } } },
      env: {},
    })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      models: [model],
      governor: createGovernor({ config: () => config.governor, store: repository }),
    })
    return { auditor: createAuditor(service, () => config), asked, repository }
  }

  const input = { runID: "run_1", taskID: "task_1", objective: "Fix the parser", answer: "Fixed the parser.", projectID: PROJECT }

  test("is asked about the goal and the agent's answer, and its 'not met' fails an unverified task", async () => {
    const { auditor, asked, repository } = audited(0.05)
    const audit = await auditor(input)

    expect(asked[0]?.prompt).toContain("Fix the parser")
    expect(asked[0]?.prompt).toContain("Fixed the parser.")
    expect(auditedVerdict(answerVerdict(input.answer), audit)).toEqual({
      value: "failed",
      reason: "The auditor model (jev) judged the goal not met",
      source: "model",
    })
    // An acting decision, audited like every other, under the task it judged.
    expect(repository.getDecision("completion:run_1:task_1")).toMatchObject({ source: "model", shadow: false })
  })

  test("never raises a verdict: 'met' leaves the task unverified, and the agent's own reason stands", async () => {
    const { auditor } = audited(0.95)
    const audit = await auditor(input)
    expect(auditedVerdict(answerVerdict(input.answer), audit).value).toBe("unverified")
    const gaveUp = answerVerdict("I give up.")
    expect(auditedVerdict(gaveUp, await audited(0.05).auditor(input))).toEqual(gaveUp)
  })

  test("without a model assigned, the rule's verdict stands", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
    })
    const audit = await createAuditor(service, () => config)(input)
    expect(audit.source).toBe("baseline")
    expect(auditedVerdict(answerVerdict(input.answer), audit).value).toBe("unverified")
  })
})
