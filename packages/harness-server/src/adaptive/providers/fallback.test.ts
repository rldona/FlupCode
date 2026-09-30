import { describe, expect, test } from "bun:test"
import { DEFAULT_DECISION_POLICY } from "../decision"
import type { DecisionRequest, DegradedReason } from "../decision"
import { createFallbackProvider } from "./fallback"
import { createGovernor } from "./governor"
import type { GovernorConfig, GovernorStore } from "./governor"
import { deterministicBaseline } from "./deterministic"
import { DecisionUnavailable } from "./provider"
import type { DecisionProvider } from "./provider"

const request: DecisionRequest<"completion"> = {
  kind: "completion",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    episodeID: "episode:1",
    objective: "finish the task",
    outcome: "success",
    toolCalls: 2,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  },
}

const signal = new AbortController().signal
const deterministicAnswer = deterministicBaseline(request).answer
const complete: DecisionProvider = {
  id: "jev",
  answer: async () => ({ answer: { verdict: "complete" }, latencyMs: 0, confidence: 0.9, modelVersion: "jev-1.13.0" }),
}
const failing = (error: unknown): DecisionProvider => ({
  id: "jev",
  answer: async () => {
    throw error
  },
})

const memStore = (): GovernorStore => {
  const usage = new Map<string, { tokens: number; calls: number }>()
  return {
    adaptiveUsage: (month) => usage.get(month) ?? { tokens: 0, calls: 0 },
    addAdaptiveUsage: (month, tokens, calls) =>
      usage.set(month, { tokens: (usage.get(month)?.tokens ?? 0) + tokens, calls: (usage.get(month)?.calls ?? 0) + calls }),
  }
}

describe("fallback equality", () => {
  test("an unreachable Jev answers exactly the deterministic answer, marked degraded", async () => {
    const fallback = createFallbackProvider({ external: failing(new Error("down")) })
    const result = await fallback.answer(request, signal)

    expect(result.answer).toEqual(deterministicAnswer)
    expect(result.source).toBe("fallback")
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("network")
    expect(result.baselineRule).toBe(deterministicBaseline(request).rule)
  })

  test("a success stays a Jev answer", async () => {
    const fallback = createFallbackProvider({ external: complete })
    const result = await fallback.answer(request, signal)
    expect(result.source).toBe("jev")
    expect(result.degraded).toBe(false)
    expect(result.modelVersion).toBe("jev-1.13.0")
    expect(result.confidence).toBe(0.9)
  })
})

describe("fallback timeout", () => {
  test("a hanging provider degrades with the timeout reason", async () => {
    const hanging: DecisionProvider = {
      id: "jev",
      answer: (_, callSignal) =>
        new Promise((_, reject) => {
          callSignal.addEventListener("abort", () => reject(new DecisionUnavailable("timeout")))
        }),
    }
    const fallback = createFallbackProvider({ external: hanging, timeoutMsFor: () => 5, maxAttempts: 1 })
    const result = await fallback.answer(request, signal)
    expect(result.answer).toEqual(deterministicAnswer)
    expect(result.degradedReason).toBe("timeout")
  })
})

describe("fallback status mapping", () => {
  test("429, 529 and 401 keep their reason", async () => {
    const cases: Array<[DegradedReason, DegradedReason]> = [
      ["rate-limited", "rate-limited"],
      ["unauthorized", "unauthorized"],
    ]
    for (const [thrown, expected] of cases) {
      const fallback = createFallbackProvider({ external: failing(new DecisionUnavailable(thrown)), maxAttempts: 1 })
      const result = await fallback.answer(request, signal)
      expect(result.degradedReason).toBe(expected)
    }
  })

  test("honours Retry-After before retrying", async () => {
    const sleeps: number[] = []
    let attempts = 0
    const external: DecisionProvider = {
      id: "jev",
      answer: async () => {
        attempts += 1
        if (attempts === 1) throw new DecisionUnavailable("rate-limited", { retryAfterMs: 1_500 })
        return { answer: { verdict: "complete" }, latencyMs: 0 }
      },
    }
    const fallback = createFallbackProvider({
      external,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const result = await fallback.answer(request, signal)
    expect(sleeps).toEqual([1_500])
    expect(result.source).toBe("jev")
    expect(result.degraded).toBe(false)
  })
})

describe("fallback retry bounds (AH-A06)", () => {
  const rateLimited = (retryAfterMs: number): DecisionProvider & { calls: number } => {
    const provider = {
      id: "jev",
      calls: 0,
      answer: async (): Promise<never> => {
        provider.calls += 1
        throw new DecisionUnavailable("rate-limited", { retryAfterMs })
      },
    }
    return provider
  }

  test("a hot call makes one attempt and never sleeps on a Retry-After", async () => {
    const external = rateLimited(30_000)
    const sleeps: number[] = []
    const fallback = createFallbackProvider({
      external,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const result = await fallback.answer(request, signal, { mode: "hot" })

    expect(external.calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(result.answer).toEqual(deterministicAnswer)
    expect(result).toMatchObject({ degraded: true, degradedReason: "rate-limited", retryAfterMs: 30_000 })
  })

  test("a batch caps Retry-After at maxDelayMs", async () => {
    const external = rateLimited(30_000)
    const sleeps: number[] = []
    const fallback = createFallbackProvider({
      external,
      maxAttempts: 3,
      maxDelayMs: 2_000,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    await fallback.answer(request, signal, { mode: "batch" })

    expect(sleeps).toEqual([2_000, 2_000])
    expect(external.calls).toBe(3)
  })

  test("a batch retry sleep ends as soon as the caller aborts", async () => {
    const external = rateLimited(30_000)
    const fallback = createFallbackProvider({ external, maxAttempts: 3, maxDelayMs: 60_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const startedAt = Date.now()
    const result = await fallback.answer(request, controller.signal, { mode: "batch" })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(external.calls).toBe(1)
    expect(result.degradedReason).toBe("rate-limited")
  })

  test("a retry the budget gate refuses is not made", async () => {
    const external = rateLimited(10)
    const fallback = createFallbackProvider({ external, maxAttempts: 3, sleep: async () => {} })
    await fallback.answer(request, signal, { mode: "batch", retry: () => false })
    expect(external.calls).toBe(1)
  })
})

describe("fallback under the governor", () => {
  const governorConfig: GovernorConfig = {
    monthlyTokenBudget: 100_000,
    hotReserveFraction: 0.2,
    breakerFailures: 2,
    breakerCooldownMs: 1_000,
    limiter: { initial: 2, max: 4, min: 1, restoreEvery: 8 },
  }

  const wire = (governor: ReturnType<typeof createGovernor>, external: DecisionProvider, now: () => number) => {
    const fallback = createFallbackProvider({
      external,
      now,
      maxAttempts: 1,
    })
    // The governor records the outcome the fallback reports; nothing is wired by hand.
    return () => governor.runHot("completion", 1, (callSignal) => fallback.answer(request, callSignal))
  }

  test("the breaker opens after consecutive failures and recovers through one probe", async () => {
    let clock = 0
    let down = true
    const governor = createGovernor({ config: () => governorConfig, store: memStore(), now: () => clock })
    const external: DecisionProvider = {
      id: "jev",
      answer: async () => {
        if (down) throw new Error("down")
        return { answer: { verdict: "complete" }, latencyMs: 0 }
      },
    }
    const run = wire(governor, external, () => clock)

    await run()
    await run()
    expect(governor.state().breaker).toBe("open")

    const blocked = await run().catch((error: unknown) => error)
    expect(blocked).toBeInstanceOf(DecisionUnavailable)
    expect(blocked).toMatchObject({ reason: "breaker-open" })

    clock = 1_000
    down = false
    const recovered = await run()
    expect(recovered.degraded).toBe(false)
    expect(governor.state().breaker).toBe("closed")
  })

  test("an exhausted budget never reaches the provider", async () => {
    let calls = 0
    const governor = createGovernor({
      config: () => ({ ...governorConfig, monthlyTokenBudget: 10 }),
      store: memStore(),
    })
    const external: DecisionProvider = {
      id: "jev",
      answer: async () => {
        calls += 1
        return { answer: { verdict: "complete" }, latencyMs: 0 }
      },
    }
    const fallback = createFallbackProvider({ external })
    await governor.runHot("first", 10, (callSignal) => fallback.answer(request, callSignal))

    const failure = await governor
      .runHot("second", 10, (callSignal) => fallback.answer(request, callSignal))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DecisionUnavailable)
    expect(failure).toMatchObject({ reason: "budget-exhausted" })
    expect(calls).toBe(1)
  })

  test("every attempt is charged to the budget: three attempts account three estimates", async () => {
    const store = memStore()
    const governor = createGovernor({ config: () => governorConfig, store })
    let calls = 0
    const external: DecisionProvider = {
      id: "jev",
      answer: async () => {
        calls += 1
        throw new DecisionUnavailable("network")
      },
    }
    const fallback = createFallbackProvider({ external, maxAttempts: 3, sleep: async () => {} })
    await governor.runBatch("completion", 10, (callSignal, retry) =>
      fallback.answer(request, callSignal, { mode: "batch", retry }),
    )

    expect(calls).toBe(3)
    expect(governor.state().tokensSpent).toBe(30)
    expect(store.adaptiveUsage(governor.state().month).calls).toBe(3)
  })

  test("a retry stops when the budget cannot cover another attempt", async () => {
    const governor = createGovernor({ config: () => ({ ...governorConfig, monthlyTokenBudget: 20 }), store: memStore() })
    let calls = 0
    const external: DecisionProvider = {
      id: "jev",
      answer: async () => {
        calls += 1
        throw new DecisionUnavailable("network")
      },
    }
    const fallback = createFallbackProvider({ external, maxAttempts: 3, sleep: async () => {} })
    await governor.runHot("completion", 10, (callSignal, retry) => fallback.answer(request, callSignal, { retry }))

    expect(calls).toBe(2)
    expect(governor.state().tokensSpent).toBe(20)
  })
})
