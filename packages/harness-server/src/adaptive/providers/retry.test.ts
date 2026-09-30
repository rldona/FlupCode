import { describe, expect, test } from "bun:test"
import type { DegradedReason } from "../decision"
import type { PredictOptions, Prediction, PredictiveModel } from "../predictive/model"
import { createRetryingModel } from "./retry"
import { createGovernor } from "./governor"
import type { GovernorConfig, GovernorStore } from "./governor"
import { DecisionUnavailable } from "./provider"

const state = { kind: "completion" as const, projectID: "/work/project", text: "{}" }
const questions = [{ id: "q0", type: "binary" as const, prompt: "complete?" }]
const signal = new AbortController().signal
const options = (overrides: Partial<PredictOptions> = {}): PredictOptions => ({
  deadlineMs: 400,
  signal,
  mode: "batch",
  ...overrides,
})

const prediction: Prediction = {
  answers: { q0: { probabilities: { yes: 0.9, no: 0.1 } } },
  latencyMs: 0,
  usage: { inputTokens: 1, costUsd: 0 },
  model: { id: "jev", version: "jev-1.13.0" },
}

/** A model whose every call runs `answer`, counting the calls. */
const modelWith = (answer: (options: PredictOptions) => Promise<Prediction>): PredictiveModel & { calls: number } => {
  const model = {
    id: "jev",
    locality: "remote" as const,
    supports: ["completion" as const],
    calls: 0,
    predict: (_state: unknown, _questions: unknown, callOptions: PredictOptions) => {
      model.calls += 1
      return answer(callOptions)
    },
  }
  return model
}
const failing = (error: unknown) => modelWith(async () => Promise.reject(error))

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

const memStore = (): GovernorStore => {
  const usage = new Map<string, { tokens: number; calls: number }>()
  return {
    adaptiveUsage: (month) => usage.get(month) ?? { tokens: 0, calls: 0 },
    addAdaptiveUsage: (month, tokens, calls) =>
      usage.set(month, {
        tokens: (usage.get(month)?.tokens ?? 0) + tokens,
        calls: (usage.get(month)?.calls ?? 0) + calls,
      }),
  }
}

describe("the retrying model", () => {
  test("keeps the wrapped model's identity", () => {
    const wrapped = createRetryingModel({ model: failing(new Error("down")) })
    expect(wrapped).toMatchObject({ id: "jev", locality: "remote", supports: ["completion"] })
  })

  test("an unreachable model rethrows its last failure, so the service degrades with its reason", async () => {
    const model = failing(new Error("down"))
    const retrying = createRetryingModel({ model, sleep: async () => {} })
    const failure = await reasonOf(retrying.predict(state, questions, options()))
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("down")
    expect(model.calls).toBe(3)
  })

  test("a success passes through unchanged", async () => {
    const retrying = createRetryingModel({ model: modelWith(async () => prediction) })
    expect(await retrying.predict(state, questions, options())).toEqual(prediction)
  })
})

describe("retry timeout", () => {
  test("a hanging model fails with the timeout reason at the per-attempt deadline", async () => {
    const hanging = modelWith(
      (callOptions) =>
        new Promise((_, reject) => {
          callOptions.signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    const retrying = createRetryingModel({ model: hanging, maxAttempts: 1 })
    const failure = await reasonOf(retrying.predict(state, questions, options({ deadlineMs: 5 })))
    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "timeout" })
  })
})

describe("retry status mapping", () => {
  test("429 and 401 keep their reason", async () => {
    const cases: DegradedReason[] = ["rate-limited", "unauthorized"]
    for (const reason of cases) {
      const retrying = createRetryingModel({ model: failing(new DecisionUnavailable(reason)), maxAttempts: 1 })
      expect(await reasonOf(retrying.predict(state, questions, options()))).toMatchObject({ reason })
    }
  })

  test("a 401 is never retried", async () => {
    const model = failing(new DecisionUnavailable("unauthorized"))
    await reasonOf(createRetryingModel({ model, sleep: async () => {} }).predict(state, questions, options()))
    expect(model.calls).toBe(1)
  })

  test("honours Retry-After before retrying", async () => {
    const sleeps: number[] = []
    const model = modelWith(async () => {
      if (model.calls === 1) throw new DecisionUnavailable("rate-limited", { retryAfterMs: 1_500 })
      return prediction
    })
    const retrying = createRetryingModel({
      model,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(await retrying.predict(state, questions, options())).toEqual(prediction)
    expect(sleeps).toEqual([1_500])
  })
})

describe("retry bounds (AH-A06)", () => {
  const rateLimited = (retryAfterMs: number) => failing(new DecisionUnavailable("rate-limited", { retryAfterMs }))

  test("a hot call makes one attempt and never sleeps on a Retry-After", async () => {
    const model = rateLimited(30_000)
    const sleeps: number[] = []
    const retrying = createRetryingModel({
      model,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const failure = await reasonOf(retrying.predict(state, questions, options({ mode: "hot" })))

    expect(model.calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(failure).toMatchObject({ reason: "rate-limited", retryAfterMs: 30_000 })
  })

  test("a batch caps Retry-After at maxDelayMs", async () => {
    const model = rateLimited(30_000)
    const sleeps: number[] = []
    const retrying = createRetryingModel({
      model,
      maxAttempts: 3,
      maxDelayMs: 2_000,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    await reasonOf(retrying.predict(state, questions, options()))

    expect(sleeps).toEqual([2_000, 2_000])
    expect(model.calls).toBe(3)
  })

  test("a batch retry sleep ends as soon as the caller aborts", async () => {
    const model = rateLimited(30_000)
    const retrying = createRetryingModel({ model, maxAttempts: 3, maxDelayMs: 60_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const startedAt = Date.now()
    const failure = await reasonOf(retrying.predict(state, questions, options({ signal: controller.signal })))

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(model.calls).toBe(1)
    expect(failure).toMatchObject({ reason: "rate-limited" })
  })

  test("a retry the budget gate refuses is not made", async () => {
    const model = rateLimited(10)
    const retrying = createRetryingModel({ model, maxAttempts: 3, sleep: async () => {} })
    await reasonOf(retrying.predict(state, questions, options({ retry: () => false })))
    expect(model.calls).toBe(1)
  })
})

describe("retries under the governor", () => {
  const governorConfig: GovernorConfig = {
    monthlyTokenBudget: 100_000,
    hotReserveFraction: 0.2,
    breakerFailures: 2,
    breakerCooldownMs: 1_000,
    limiter: { initial: 2, max: 4, min: 1, restoreEvery: 8 },
  }

  test("the breaker opens after consecutive failures and recovers through one probe", async () => {
    let clock = 0
    let down = true
    const governor = createGovernor({ config: () => governorConfig, store: memStore(), now: () => clock })
    const retrying = createRetryingModel({
      model: modelWith(async () => {
        if (down) throw new Error("down")
        return prediction
      }),
      maxAttempts: 1,
    })
    // The governor records the failure the model rethrows; nothing is wired by hand.
    const run = () =>
      governor.runHot("completion", 1, (callSignal) =>
        retrying.predict(state, questions, options({ signal: callSignal, mode: "hot" })),
      )

    await reasonOf(run())
    await reasonOf(run())
    expect(governor.state().breaker).toBe("open")

    const blocked = await reasonOf(run())
    expect(blocked).toBeInstanceOf(DecisionUnavailable)
    expect(blocked).toMatchObject({ reason: "breaker-open" })

    clock = 1_000
    down = false
    expect(await run()).toEqual(prediction)
    expect(governor.state().breaker).toBe("closed")
  })

  test("an exhausted budget never reaches the model", async () => {
    const governor = createGovernor({
      config: () => ({ ...governorConfig, monthlyTokenBudget: 10 }),
      store: memStore(),
    })
    const model = modelWith(async () => prediction)
    const retrying = createRetryingModel({ model })
    await governor.runHot("first", 10, (callSignal) =>
      retrying.predict(state, questions, options({ signal: callSignal })),
    )

    const failure = await reasonOf(
      governor.runHot("second", 10, (callSignal) =>
        retrying.predict(state, questions, options({ signal: callSignal })),
      ),
    )
    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "budget-exhausted" })
    expect(model.calls).toBe(1)
  })

  test("every attempt is charged to the budget: three attempts account three estimates", async () => {
    const store = memStore()
    const governor = createGovernor({ config: () => governorConfig, store })
    const model = failing(new DecisionUnavailable("network"))
    const retrying = createRetryingModel({ model, maxAttempts: 3, sleep: async () => {} })
    await reasonOf(
      governor.runBatch("completion", 10, (callSignal, retry) =>
        retrying.predict(state, questions, options({ signal: callSignal, retry })),
      ),
    )

    expect(model.calls).toBe(3)
    expect(governor.state().tokensSpent).toBe(30)
    expect(store.adaptiveUsage(governor.state().month).calls).toBe(3)
  })

  test("a retry stops when the budget cannot cover another attempt", async () => {
    const governor = createGovernor({
      config: () => ({ ...governorConfig, monthlyTokenBudget: 20 }),
      store: memStore(),
    })
    const model = failing(new DecisionUnavailable("network"))
    const retrying = createRetryingModel({ model, maxAttempts: 3, sleep: async () => {} })
    await reasonOf(
      governor.runHot("completion", 10, (callSignal, retry) =>
        retrying.predict(state, questions, options({ signal: callSignal, retry })),
      ),
    )

    expect(model.calls).toBe(2)
    expect(governor.state().tokensSpent).toBe(20)
  })
})
