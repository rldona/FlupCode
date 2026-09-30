import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import { DEFAULT_DECISION_POLICY } from "../decision"
import type { DecisionRequest } from "../decision"
import { decisionID } from "../decision-record"
import { createDecisionService } from "../decision-service"
import { createAdaptiveEgressGuard } from "../egress"
import type { PredictionState, Question } from "../predictive/model"
import { createGovernor } from "./governor"
import { DecisionUnavailable, degradedReasonOf } from "./provider"
import { createSmallLlmModel, parseSmallLlmAnswer, smallLlmPrompt } from "./small-llm"
import type { SmallLlmEngine } from "./small-llm"
import type { TranscriptMessage } from "../../engine"
import { SqliteRoutineRepository } from "../../repository"

const PROJECT = "/work/project"

/** `small-llm`'s own consent for one project and `skillRelevance`, which a call needs to leave at all. */
const consented = {
  models: { skillRelevance: "small-llm" },
  egress: { providers: { "small-llm": { enabled: true, projects: [PROJECT], kinds: { skillRelevance: true } } } },
}

const guard = (block: unknown = consented) => {
  const config = resolveAdaptiveConfig({ block, env: {} })
  return { config, egress: createAdaptiveEgressGuard({ config: () => config }) }
}

const state: PredictionState = { kind: "skillRelevance", projectID: PROJECT, text: '{"objective":"fix the login bug"}' }

const questions: Question[] = [
  { id: "q0", type: "binary", prompt: 'Load the "debugging" skill for: fix the login bug?' },
  { id: "q1", type: "binary", prompt: 'Load the "release" skill for: fix the login bug?' },
]

const assistant = (
  text: string,
  usage: { input?: number; cacheRead?: number; cost?: number } = {},
): TranscriptMessage => ({
  info: {
    role: "assistant",
    cost: usage.cost ?? 0,
    tokens: { input: usage.input ?? 0, output: 12, cache: { read: usage.cacheRead ?? 0, write: 0 } },
  },
  parts: [{ type: "text", text }],
})

/** An engine-like fake: it records every call and answers the turn with `reply`, or never. */
const fakeEngine = (reply: TranscriptMessage[] | "hang", options: { failPrompt?: Error } = {}) => {
  const calls: string[] = []
  const prompts: string[] = []
  const engine: SmallLlmEngine = {
    createSession: async (input) => {
      calls.push(`create:${input.permission?.[0]?.permission}:${input.directory ?? ""}`)
      return { id: "ses_throwaway" }
    },
    prompt: async (input) => {
      calls.push(`prompt:${input.model?.providerID}/${input.model?.id}`)
      prompts.push(input.text)
      if (options.failPrompt) throw options.failPrompt
      return undefined
    },
    waitForIdle: async (_sessionID, wait) => {
      if (reply !== "hang") return
      // A turn that never ends: it only stops when the model's own deadline is reached.
      while (!wait?.stopped?.()) await Bun.sleep(5)
    },
    messages: async () => {
      calls.push("messages")
      return reply === "hang" ? [] : [{ info: { role: "user" }, parts: [{ type: "text", text: "question" }] }, ...reply]
    },
    interrupt: async (sessionID) => {
      calls.push(`interrupt:${sessionID}`)
    },
    deleteSession: async (sessionID) => {
      calls.push(`delete:${sessionID}`)
      return true
    },
  }
  return { engine, calls, prompts }
}

const modelOn = (engine: SmallLlmEngine, block: unknown = consented) =>
  createSmallLlmModel({
    engine,
    egress: guard(block).egress,
    model: () => ({ providerID: "anthropic", id: "claude-haiku-4-5" }),
  })

const within = (deadlineMs = 5_000) => ({ deadlineMs, signal: new AbortController().signal, mode: "batch" as const })

describe("the small-llm predictive model (AH-C04)", () => {
  test("a valid JSON answer becomes one distribution per question, with measured cost and tokens", async () => {
    const fake = fakeEngine([
      assistant('{"q0": {"yes": 0.8, "no": 0.2}, "q1": {"yes": 0.1, "no": 0.9}}', {
        input: 900,
        cacheRead: 100,
        cost: 0.0042,
      }),
    ])
    const prediction = await modelOn(fake.engine).predict(state, questions, within())

    expect(prediction.answers).toEqual({
      q0: { probabilities: { yes: 0.8, no: 0.2 } },
      q1: { probabilities: { yes: 0.1, no: 0.9 } },
    })
    expect(prediction.usage).toEqual({ inputTokens: 1_000, costUsd: 0.0042 })
    expect(prediction.model).toEqual({ id: "small-llm", version: "anthropic/claude-haiku-4-5" })
    expect(prediction.latencyMs).toBeGreaterThanOrEqual(0)
    // No tools, in the project, on the configured model; answered, so deleted but not interrupted.
    expect(fake.calls).toEqual([
      `create:*:${PROJECT}`,
      "prompt:anthropic/claude-haiku-4-5",
      "messages",
      "delete:ses_throwaway",
    ])
  })

  test("the prompt carries the redacted state, every question with its options and the JSON shape", async () => {
    const fake = fakeEngine([assistant('{"q0": {"yes": 1, "no": 0}, "q1": {"yes": 0, "no": 1}}')])
    await modelOn(fake.engine).predict(state, questions, within())
    const prompt = fake.prompts[0]!
    expect(prompt).toContain(state.text)
    expect(prompt).toContain('- q0 (binary; options: "yes", "no"): Load the "debugging" skill')
    expect(prompt).toContain('{"q0": {"yes": <p>, "no": <p>}, "q1": {"yes": <p>, "no": <p>}}')
    expect(prompt).toContain("ONLY one JSON object")
    expect(smallLlmPrompt("s", [{ id: "q0", type: "score", prompt: "risk?", options: ["low", "high"] }])).toContain(
      'q0 (score, ordered lowest to highest; options: "low", "high")',
    )
  })

  test("prose and a fence around the JSON are ignored, and a brace inside a string is not a boundary", () => {
    const text = [
      "Sure! Here is my assessment {not json}.",
      "```json",
      '{"q0": {"yes": 0.7, "no": 0.3}, "q1": {"yes": 0.2, "no": 0.8}, "note": "braces } inside"}',
      "```",
      "Hope that helps.",
    ].join("\n")
    expect(parseSmallLlmAnswer(text, questions)).toEqual({
      q0: { probabilities: { yes: 0.7, no: 0.3 } },
      q1: { probabilities: { yes: 0.2, no: 0.8 } },
    })
  })

  test("a distribution that does not sum to 1 is normalised; a lone side or a bare p(yes) is completed", () => {
    const answers = parseSmallLlmAnswer('{"q0": {"yes": 0.6, "no": 0.6}, "q1": 0.25}', questions)
    expect(answers.q0!.probabilities).toEqual({ yes: 0.5, no: 0.5 })
    expect(answers.q1!.probabilities).toEqual({ yes: 0.25, no: 0.75 })
    expect(parseSmallLlmAnswer('{"q0": {"no": 0.9}, "q1": {"yes": 0.4}}', questions).q0!.probabilities).toEqual({
      yes: 1 - 0.9,
      no: 0.9,
    })
    const choice: Question[] = [{ id: "q0", type: "choice", prompt: "tier?", options: ["CHEAP", "HIGH", "MAX"] }]
    expect(parseSmallLlmAnswer('{"q0": {"CHEAP": 0.2, "HIGH": 0.2}}', choice).q0!.probabilities).toEqual({
      CHEAP: 0.5,
      HIGH: 0.5,
      MAX: 0,
    })
  })

  test("a missing id, an unknown option, an out-of-range value or no JSON at all is malformed", () => {
    const malformed = (text: string, asked: readonly Question[] = questions) => {
      try {
        parseSmallLlmAnswer(text, asked)
        return undefined
      } catch (error) {
        return degradedReasonOf(error)
      }
    }
    expect(malformed('{"q0": {"yes": 0.8, "no": 0.2}}')).toBe("malformed")
    expect(malformed('{"q0": {"yes": 0.8, "maybe": 0.2}, "q1": {"yes": 0.5, "no": 0.5}}')).toBe("malformed")
    expect(malformed('{"q0": {"yes": 1.4, "no": 0}, "q1": {"yes": 0.5, "no": 0.5}}')).toBe("malformed")
    expect(malformed('{"q0": {"yes": 0, "no": 0}, "q1": {"yes": 0.5, "no": 0.5}}')).toBe("malformed")
    expect(malformed('{"w0": {"yes": 1, "no": 0}, "w1": {"yes": 1, "no": 0}}')).toBe("malformed")
    expect(malformed("I think you should load the debugging skill.")).toBe("malformed")
    expect(malformed("")).toBe("malformed")
    expect(malformed('{"q0": {"CHEAP": 2}}', [{ id: "q0", type: "choice", prompt: "t", options: ["CHEAP"] }])).toBe(
      "malformed",
    )
  })

  test("a malformed answer through the model is a malformed failure, and the session is still deleted", async () => {
    const fake = fakeEngine([assistant("I would load the debugging skill.", { input: 400, cost: 0.001 })])
    const error = await modelOn(fake.engine)
      .predict(state, questions, within())
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(degradedReasonOf(error)).toBe("malformed")
    expect(fake.calls.at(-1)).toBe("delete:ses_throwaway")
  })

  test("a turn past the deadline is a timeout that interrupts and deletes the throwaway session", async () => {
    const fake = fakeEngine("hang")
    const error = await modelOn(fake.engine)
      .predict(state, questions, within(30))
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(degradedReasonOf(error)).toBe("timeout")
    expect(fake.calls).toContain("interrupt:ses_throwaway")
    expect(fake.calls.at(-1)).toBe("delete:ses_throwaway")
    expect(fake.calls).not.toContain("messages")
  })

  test("a caller abort stops the call the same way", async () => {
    const fake = fakeEngine("hang")
    const controller = new AbortController()
    const pending = modelOn(fake.engine).predict(state, questions, {
      deadlineMs: 60_000,
      signal: controller.signal,
      mode: "hot",
    })
    await Bun.sleep(10)
    controller.abort()
    expect(degradedReasonOf(await pending.catch((cause: unknown) => cause))).toBe("timeout")
    expect(fake.calls.slice(-2)).toEqual(["interrupt:ses_throwaway", "delete:ses_throwaway"])
  })

  test("an engine failure is a network failure, and the session is interrupted and deleted", async () => {
    const fake = fakeEngine([], { failPrompt: new Error("engine said no") })
    const error = await modelOn(fake.engine)
      .predict(state, questions, within())
      .catch((cause: unknown) => cause)
    expect(degradedReasonOf(error)).toBe("network")
    expect(fake.calls.slice(-2)).toEqual(["interrupt:ses_throwaway", "delete:ses_throwaway"])
  })

  test("without its own consent, without a small model or without questions it never opens a session", async () => {
    const fake = fakeEngine([assistant("{}")])
    const denied = await modelOn(fake.engine, { models: { skillRelevance: "small-llm" } })
      .predict(state, questions, within())
      .catch((cause: unknown) => cause)
    expect(degradedReasonOf(denied)).toBe("egress-denied")
    const unconfigured = await createSmallLlmModel({
      engine: fake.engine,
      egress: guard().egress,
      model: () => undefined,
    })
      .predict(state, questions, within())
      .catch((cause: unknown) => cause)
    expect(degradedReasonOf(unconfigured)).toBe("provider-disabled")
    const empty = await modelOn(fake.engine)
      .predict(state, [], within())
      .catch((cause: unknown) => cause)
    expect(degradedReasonOf(empty)).toBe("malformed")
    expect(fake.calls).toEqual([])
  })

  test("it is remote, and answers skillRelevance, completion and failure only", () => {
    const model = modelOn(fakeEngine([]).engine)
    expect(model.id).toBe("small-llm")
    expect(model.locality).toBe("remote")
    expect([...model.supports]).toEqual(["skillRelevance", "completion", "failure"])
  })
})

describe("small-llm through the decision service (AH-C04)", () => {
  const relevance = (): DecisionRequest<"skillRelevance"> => ({
    kind: "skillRelevance",
    episodeID: "episode:run:1",
    sessionID: "ses_1",
    projectID: PROJECT,
    policy: { ...DEFAULT_DECISION_POLICY, timeoutMs: 5_000 },
    state: {
      sessionID: "ses_1",
      objective: "fix the login bug",
      skills: [
        { name: "debugging", description: "Find and fix bugs", learned: false },
        { name: "release", description: "Cut a release", learned: false },
      ],
    },
  })

  const serviceWith = (engine: SmallLlmEngine, block: unknown = consented) => {
    const repository = new SqliteRoutineRepository(":memory:")
    const { config, egress } = guard(block)
    const service = createDecisionService({
      repository,
      config: () => config,
      egress,
      models: [
        createSmallLlmModel({ engine, egress, model: () => ({ providerID: "anthropic", id: "claude-haiku-4-5" }) }),
      ],
      governor: createGovernor({ config: () => config.governor, store: repository }),
    })
    return { repository, service }
  }

  test("answers skillRelevance and records a decision row with provider_id small-llm and its cost", async () => {
    const fake = fakeEngine([
      assistant('Answer: {"q0": {"yes": 0.9, "no": 0.1}, "q1": {"yes": 0.05, "no": 0.95}}', {
        input: 1_200,
        cost: 0.0031,
      }),
    ])
    const { repository, service } = serviceWith(fake.engine)
    const result = await service.predict(relevance())

    expect(result.source).toBe("model")
    expect(result.answer).toEqual({ load: ["debugging"] })
    expect(repository.getDecision(decisionID("skillRelevance", "episode:run:1"))).toMatchObject({
      kind: "skillRelevance",
      source: "model",
      provider: "small-llm",
      providerID: "small-llm",
      providerVersion: "anthropic/claude-haiku-4-5",
      costUsd: 0.0031,
      inputTokens: 1_200,
      degraded: false,
    })
    expect(fake.calls.at(-1)).toBe("delete:ses_throwaway")
    repository.close()
  })

  test("a timed-out call degrades to the baseline with reason timeout and leaves no session behind", async () => {
    const fake = fakeEngine("hang")
    const { repository, service } = serviceWith(fake.engine)
    const result = await service.predict({ ...relevance(), policy: { ...DEFAULT_DECISION_POLICY, timeoutMs: 30 } })
    expect(result).toMatchObject({ degraded: true, degradedReason: "timeout" })
    expect(repository.getDecision(decisionID("skillRelevance", "episode:run:1"))).toMatchObject({
      source: "fallback",
      providerID: "small-llm",
      degradedReason: "timeout",
    })
    expect(fake.calls.at(-1)).toBe("delete:ses_throwaway")
    repository.close()
  })

  test("no kind asks it unless models.<kind> names it", async () => {
    const fake = fakeEngine([assistant('{"q0": {"yes": 1, "no": 0}, "q1": {"yes": 1, "no": 0}}')])
    const { repository, service } = serviceWith(fake.engine, { egress: consented.egress })
    const result = await service.predict(relevance())
    expect(result.source).toBe("baseline")
    expect(fake.calls).toEqual([])
    repository.close()
  })
})
