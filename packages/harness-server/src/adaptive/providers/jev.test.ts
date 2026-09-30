import { describe, expect, test } from "bun:test"
import { DEFAULT_JEV_CONFIG, resolveAdaptiveConfig } from "../config"
import { DEFAULT_DECISION_POLICY } from "../decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "../decision"
import { createEgressGuard } from "../egress"
import { createJevClient, createJevProvider } from "./jev"
import type { JevClient, JevFetch, JevFetchResponse } from "./jev"
import type { JevPrediction, JevQuestion } from "./jev-parse"
import { DecisionUnavailable } from "./provider"

const CANARY = "canary-secret-value-1234567890"

const jevConfig = () => ({ ...DEFAULT_JEV_CONFIG, endpoint: "https://jev.test/v1/systemone" })

const guard = (block: unknown, secrets: () => string[] = () => []) =>
  createEgressGuard({ config: () => resolveAdaptiveConfig({ block, env: {} }), secrets })

/** Egress fully opt-in for one project and one kind, which is what a call needs to leave at all. */
const allowed = (secrets: () => string[] = () => []) =>
  guard({ jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { completion: true } } }, secrets)

const completion = (objective = "finish the task"): DecisionRequest<"completion"> => ({
  kind: "completion",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    episodeID: "episode:1",
    objective,
    outcome: "success",
    toolCalls: 2,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  },
})

const questions: JevQuestion[] = [
  { id: "done", type: "noul", prompt: "is the episode complete?" },
  { id: "route", type: "choice", prompt: "which tier?", choices: ["CHEAP", "BALANCED", "HIGH", "MAX"] },
  { id: "risk", type: "score", prompt: "how risky?", choices: ["low", "mid", "high"] },
]
const completionComplete: JevQuestion = { id: "done", type: "noul", prompt: "is the episode complete?" }

type JevInput = Parameters<JevFetch>[0]

const wireQuestions = (body: string): Array<{ id: string }> => {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== "object" || parsed === null || !("questions" in parsed) || !Array.isArray(parsed.questions)) {
    return []
  }
  return parsed.questions.flatMap((question) =>
    typeof question === "object" && question !== null && "id" in question && typeof question.id === "string"
      ? [{ id: question.id }]
      : [],
  )
}

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}): JevFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => payload,
})

const recorder = (respond: (input: JevInput) => JevFetchResponse | Promise<JevFetchResponse>) => {
  const calls: JevInput[] = []
  const fetch: JevFetch = async (input) => {
    calls.push(input)
    return respond(input)
  }
  return { fetch, calls }
}

const answersFor = (count: number): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`w${index}`, { type: "noul", probability: 0.5 }]))

describe("JevClient parsing", () => {
  test("parses noul, choice and score into typed answers", async () => {
    const { fetch, calls } = recorder(() =>
      json({
        model: "jev-1.13.0",
        answers: {
          w0: { type: "noul", probability: 0.8 },
          w1: { type: "choice", choice: "HIGH", probabilities: { CHEAP: 0.1, HIGH: 0.9 }, confidence: 0.9 },
          w2: { type: "score", score: 2, legend: ["low", "mid", "high"], probabilities: { low: 0.1, high: 0.7 }, confidence: 0.7 },
        },
      }),
    )
    const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
    const prediction = await client.predictOne(completion(), questions)

    expect(calls).toHaveLength(1)
    expect(prediction.modelVersion).toBe("jev-1.13.0")
    expect(prediction.answers.done).toEqual({ type: "noul", probability: 0.8 })
    expect(prediction.answers.route).toEqual({
      type: "choice",
      choice: "HIGH",
      probabilities: { CHEAP: 0.1, HIGH: 0.9 },
      confidence: 0.9,
    })
    expect(prediction.answers.risk).toEqual({
      type: "score",
      score: 2,
      legend: ["low", "mid", "high"],
      probabilities: { low: 0.1, high: 0.7 },
      confidence: 0.7,
    })
  })

  test("an answer Jev did not send is absent, not defaulted", async () => {
    const { fetch } = recorder(() => json({ model: "jev-1.13.0", answers: { w0: { type: "noul", probability: 0.3 } } }))
    const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
    const prediction = await client.predictOne(completion(), questions)
    expect(prediction.answers.done).toEqual({ type: "noul", probability: 0.3 })
    expect(prediction.answers.route).toBeUndefined()
  })
})

describe("JevClient batching", () => {
  test("groups every question of a state into one request per state", async () => {
    const { fetch, calls } = recorder(({ body }) => {
      return json({ model: "jev-1.13.0", answers: answersFor(wireQuestions(body).length) })
    })
    const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
    const predictions = await client.predictMany([completion("one"), completion("two")], questions)

    expect(predictions).toHaveLength(2)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(wireQuestions(call.body).map((question) => question.id)).toEqual(["w0", "w1", "w2"])
    }
  })

  test("predictOne never queues behind a pending batch", async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fetch } = recorder(async ({ body }) => {
      const bodyQuestions = wireQuestions(body)
      // Only the batch requests block; the single one must be able to answer right away.
      if (bodyQuestions.length === questions.length) await blocked
      return json({ model: "jev-1.13.0", answers: answersFor(bodyQuestions.length) })
    })
    const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
    const batch = client.predictMany([completion("one"), completion("two")], questions)
    const single = await client.predictOne(completion("three"), [completionComplete])

    expect(single.answers.done).toEqual({ type: "noul", probability: 0.5 })
    release?.()
    await batch
  })
})

describe("JevClient egress", () => {
  test("the request body never contains a canary", async () => {
    const { fetch, calls } = recorder(({ body }) => {
      return json({ model: "jev-1.13.0", answers: answersFor(wireQuestions(body).length) })
    })
    const client = createJevClient({ fetch, egress: allowed(() => [CANARY]), config: jevConfig })
    await client.predictOne(completion(`finish ${CANARY}`), [completionComplete])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).not.toContain(CANARY)
    expect(calls[0]?.body).toContain("[REDACTED]")
  })

  test("the full body is redacted end to end: no canary in objective or skill text", async () => {
    const { fetch, calls } = recorder(({ body }) =>
      json({ model: "jev-1.13.0", answers: answersFor(wireQuestions(body).length) }),
    )
    const egress = guard(
      { jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { skillRelevance: true } } },
      () => [CANARY],
    )
    const provider = createJevProvider({ client: createJevClient({ fetch, egress, config: jevConfig }) })
    const request: DecisionRequest<"skillRelevance"> = {
      kind: "skillRelevance",
      projectID: "/work/project",
      policy: DEFAULT_DECISION_POLICY,
      state: {
        sessionID: "session-1",
        objective: `finish ${CANARY}`,
        skills: [{ name: `skill-${CANARY}`, description: `desc ${CANARY}`, learned: false }],
      },
    }
    await provider.answer(request, new AbortController().signal)

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    // The whole serialized body, not only the state, is clean.
    expect(body).not.toContain(CANARY)
    expect(body).toContain("[REDACTED]")
    // It is still the full envelope with the question the guard wrote.
    expect(body).toContain('"questions":[{"id":"w0","type":"noul"')
  })

  test("a kind that is not allowlisted never issues a request", async () => {
    const { fetch, calls } = recorder(() => json({}))
    const client = createJevClient({ fetch, egress: guard({ jev: { enabled: true } }), config: jevConfig })
    const failure = await client.predictOne(completion(), questions).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "egress-denied" })
    expect(calls).toHaveLength(0)
  })
})

const signal = new AbortController().signal

/** A client that answers with a canned prediction; the network boundary is faked, nothing else. */
const clientWith = (prediction: JevPrediction): JevClient => ({
  predictOne: async () => prediction,
  predictMany: async () => [prediction],
})

const sampleRequest = <Q extends DecisionKind>(kind: Q, state: DecisionSpec[Q]["state"]): DecisionRequest<Q> => ({
  kind,
  state,
  policy: DEFAULT_DECISION_POLICY,
})

describe("JevProvider interpretation", () => {
  test("a noul answer becomes the typed verdict with its model version and probabilities", async () => {
    const provider = createJevProvider({
      client: clientWith({ modelVersion: "jev-1.13.0", answers: { verdict: { type: "noul", probability: 0.75 } } }),
    })
    const answer = await provider.answer(completion(), signal)

    expect(answer.modelVersion).toBe("jev-1.13.0")
    expect(answer.answer).toEqual({ verdict: "complete" })
    // `p(yes)` is not a confidence: the adapter reports the distribution and the service calibrates.
    expect(answer.confidence).toBeUndefined()
    expect(answer.probabilities).toEqual({ complete: 0.75, not_complete: 0.25 })
  })

  test("a confident no is a verdict, not a missing confidence", async () => {
    const verdict = (probability: number) =>
      createJevProvider({ client: clientWith({ answers: { verdict: { type: "noul", probability } } }) })
    const notComplete = await verdict(0.05).answer(completion(), signal)
    expect(notComplete.answer).toEqual({ verdict: "not_complete" })
    expect(notComplete.probabilities).toEqual({ complete: 0.05, not_complete: 0.95 })
    expect(notComplete.confidence).toBeUndefined()

    const failure = await verdict(0.05).answer(
      sampleRequest("failure", { repeatedCalls: 5, repeatedErrors: 0, stepsUsed: 5 }),
      signal,
    )
    expect(failure.answer).toEqual({ verdict: "continue" })
    expect(failure.probabilities).toEqual({ continue: 0.95, intervene: 0.05 })
    expect(failure.confidence).toBeUndefined()
  })

  test("skill gates carry every p(yes), including the confident noes", async () => {
    const provider = createJevProvider({
      client: clientWith({ answers: { a: { type: "noul", probability: 0.9 }, b: { type: "noul", probability: 0.02 } } }),
    })
    const answer = await provider.answer(
      sampleRequest("skillRelevance", {
        sessionID: "s",
        objective: "o",
        skills: [
          { name: "a", description: "a", learned: false },
          { name: "b", description: "b", learned: false },
        ],
      }),
      signal,
    )
    expect(answer.answer).toEqual({ load: ["a"] })
    expect(answer.probabilities).toEqual({ a: 0.9, b: 0.02 })
    expect(answer.confidence).toBeUndefined()
  })

  test("choice answers become a disposition per item, keyed by id", async () => {
    const provider = createJevProvider({
      client: clientWith({
        modelVersion: "jev-1.13.0",
        answers: {
          a: { type: "choice", choice: "drop", probabilities: { drop: 0.9 }, confidence: 0.9 },
          b: { type: "choice", choice: "keep", probabilities: { keep: 0.7 }, confidence: 0.7 },
        },
      }),
    })
    const answer = await provider.answer(
      sampleRequest("contextItem", {
        objective: "tidy",
        items: [
          { id: "a", kind: "file", tokens: 1, referenced: true, anchors: 0, archived: false },
          { id: "b", kind: "file", tokens: 1, referenced: false, anchors: 0, archived: false },
        ],
      }),
      signal,
    )

    expect(answer.answer).toEqual({ decisions: [{ id: "a", disposition: "drop" }, { id: "b", disposition: "keep" }] })
    // The weakest item sets the confidence the service then gates on.
    expect(answer.confidence).toBe(0.7)
  })

  test("a score answer is capped at the learned ceiling, raise-only", async () => {
    const score = (value: number) =>
      createJevProvider({
        client: clientWith({
          modelVersion: "jev-1.13.0",
          answers: {
            risk: { type: "score", score: value, legend: ["ALLOW", "CONFIRM", "REVIEW", "DENY"], probabilities: { DENY: 0.8 }, confidence: 0.8 },
          },
        }),
      })
    const answer = await score(3).answer(sampleRequest("toolRisk", { tool: "bash", argsDigest: "d" }), signal)

    // DENY and REVIEW are capped to CONFIRM: a learned policy can never exceed the ceiling (FH-063).
    expect(answer.answer).toEqual({ risk: "CONFIRM" })
    expect(answer.confidence).toBe(0.8)
    expect((await score(2).answer(sampleRequest("toolRisk", { tool: "bash", argsDigest: "d" }), signal)).answer).toEqual({
      risk: "CONFIRM",
    })
    // A low score is not lifted by the cap.
    expect((await score(0).answer(sampleRequest("toolRisk", { tool: "bash", argsDigest: "d" }), signal)).answer).toEqual({
      risk: "ALLOW",
    })
  })

  test("an answer of the wrong type, or no question to ask, is malformed", async () => {
    const wrongType = createJevProvider({
      client: clientWith({ answers: { verdict: { type: "choice", choice: "HIGH", probabilities: {}, confidence: 0.9 } } }),
    })
    const mismatched = await wrongType.answer(completion(), signal).catch((cause: unknown) => cause)
    expect(mismatched).toBeInstanceOf(DecisionUnavailable)
    expect(mismatched).toMatchObject({ reason: "malformed" })

    const noCandidates = createJevProvider({ client: clientWith({ answers: {} }) })
    const empty = await noCandidates
      .answer(sampleRequest("skillRelevance", { sessionID: "s", objective: "o", skills: [] }), signal)
      .catch((cause: unknown) => cause)
    expect(empty).toBeInstanceOf(DecisionUnavailable)
    expect(empty).toMatchObject({ reason: "malformed" })
  })
})

describe("JevClient malformed responses", () => {
  test("maps 422 and an empty answer set to the malformed reason", async () => {
    const cases: Array<() => JevFetchResponse> = [
      () => json({ error: "bad request" }, 422),
      () => json({ model: "jev-1.13.0", answers: {} }),
    ]
    for (const respond of cases) {
      const { fetch } = recorder(respond)
      const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
      const failure = await client.predictOne(completion(), [completionComplete]).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(DecisionUnavailable)
      expect(failure).toMatchObject({ reason: "malformed" })
    }
  })

  test("a body that is not JSON is malformed", async () => {
    const { fetch } = recorder(() => ({
      ok: true,
      status: 200,
      headers: new Headers({}),
      json: async () => {
        throw new Error("not json")
      },
    }))
    const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
    const failure = await client.predictOne(completion(), [completionComplete]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "malformed" })
  })
})

describe("JevClient failures", () => {
  test("maps 429, 529 and 401 to reasons and reads Retry-After", async () => {
    const cases: Array<[number, string]> = [
      [429, "rate-limited"],
      [529, "rate-limited"],
      [401, "unauthorized"],
    ]
    for (const [status, reason] of cases) {
      const { fetch } = recorder(() => json({}, status, { "retry-after": "2" }))
      const client = createJevClient({ fetch, egress: allowed(), config: jevConfig })
      const failure = await client.predictOne(completion(), [completionComplete]).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(DecisionUnavailable)
      expect(failure).toMatchObject({ reason })
      if (failure instanceof DecisionUnavailable && reason === "rate-limited") expect(failure.retryAfterMs).toBe(2_000)
    }
  })

  test("aborts a hot-path call at the strict timeout", async () => {
    const hanging: JevFetch = (input) =>
      new Promise<JevFetchResponse>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    const client = createJevClient({
      fetch: hanging,
      egress: allowed(),
      config: () => ({ ...DEFAULT_JEV_CONFIG, timeoutMs: 5 }),
    })
    const failure = await client.predictOne(completion(), [completionComplete]).catch((error: unknown) => error)
    expect(failure).toMatchObject({ reason: "timeout" })
  })
})
