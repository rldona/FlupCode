import { describe, expect, test } from "bun:test"
import { assembleById } from "./assembly"
import { createGovernor } from "./governor"
import type { GovernorConfig, GovernorStore } from "./governor"
import { DecisionUnavailable } from "./provider"

const config: GovernorConfig = {
  monthlyTokenBudget: 100_000,
  hotReserveFraction: 0.2,
  breakerFailures: 3,
  breakerCooldownMs: 1_000,
  limiter: { initial: 4, max: 4, min: 1, restoreEvery: 2 },
}

const memStore = (): GovernorStore => {
  const usage = new Map<string, { tokens: number; calls: number }>()
  return {
    adaptiveUsage: (month) => usage.get(month) ?? { tokens: 0, calls: 0 },
    addAdaptiveUsage: (month, tokens, calls) =>
      usage.set(month, { tokens: (usage.get(month)?.tokens ?? 0) + tokens, calls: (usage.get(month)?.calls ?? 0) + calls }),
  }
}

/** A store that can be emptied so a test can model the budget coming back within the same month. */
const resettableStore = (): GovernorStore & { reset: () => void } => {
  const usage = new Map<string, { tokens: number; calls: number }>()
  return {
    adaptiveUsage: (month) => usage.get(month) ?? { tokens: 0, calls: 0 },
    addAdaptiveUsage: (month, tokens, calls) =>
      usage.set(month, { tokens: (usage.get(month)?.tokens ?? 0) + tokens, calls: (usage.get(month)?.calls ?? 0) + calls }),
    reset: () => usage.clear(),
  }
}

describe("the adaptive limiter", () => {
  test("halves concurrency on a rate limit and restores it on successes", () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    expect(governor.state().concurrency).toBe(4)

    governor.recordRateLimit()
    expect(governor.state().concurrency).toBe(2)
    governor.recordRateLimit()
    expect(governor.state().concurrency).toBe(1)
    governor.recordRateLimit()
    expect(governor.state().concurrency).toBe(1)

    governor.recordSuccess()
    governor.recordSuccess()
    expect(governor.state().concurrency).toBe(2)
  })

  test("a burst of rate limits does not fail the batch callers", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    governor.recordRateLimit()

    const results = await Promise.all([1, 2, 3, 4, 5].map((value) => governor.runBatch(`k${value}`, 1, async () => value)))
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(governor.state().inflight).toBe(0)
  })
})

describe("single-flight", () => {
  test("two concurrent identical requests produce exactly one outbound call", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    let calls = 0
    const work = async () => {
      calls += 1
      await Promise.resolve()
      return "answer"
    }

    const [first, second] = await Promise.all([governor.runHot("same", 1, work), governor.runHot("same", 1, work)])
    expect(calls).toBe(1)
    expect(first).toBe("answer")
    expect(second).toBe("answer")
  })

  test("two concurrent identical batch requests still collapse into one call", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    let calls = 0
    const work = async () => {
      calls += 1
      await Promise.resolve()
      return "answer"
    }

    await Promise.all([governor.runBatch("same", 1, work), governor.runBatch("same", 1, work)])
    expect(calls).toBe(1)
  })

  test("a hot call does not join an in-flight batch with the same key", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    let releaseBatch: () => void = () => {}
    let batchStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      batchStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseBatch = resolve
    })
    let calls = 0

    const batch = governor.runBatch("same", 1, async () => {
      calls += 1
      batchStarted()
      await gate
      return "batch"
    })
    await started

    // The hot call shares the key but must run its own work: without the mode-scoped key it would
    // join the batch flight and block until the gate opens, inheriting the batch's limiter wait.
    const hot = await governor.runHot("same", 1, async () => {
      calls += 1
      return "hot"
    })
    expect(hot).toBe("hot")
    expect(calls).toBe(2)

    releaseBatch()
    expect(await batch).toBe("batch")
  })

  test("breaker and budget stay shared across modes", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    await Promise.all([
      governor.runHot("same", 1, async () => "hot"),
      governor.runBatch("same", 1, async () => "batch"),
    ])
    // Two distinct flights each reserve once; the shared budget counts both, not one per question.
    expect(governor.state().tokensSpent).toBe(2)

    // The breaker is the same closure for both entries: once open, it refuses either mode.
    governor.recordFailure("network")
    governor.recordFailure("network")
    governor.recordFailure("network")
    expect(governor.state().breaker).toBe("open")
    const hot = await governor.runHot("later-hot", 1, async () => "hot").catch((error: unknown) => error)
    const batch = await governor.runBatch("later-batch", 1, async () => "batch").catch((error: unknown) => error)
    expect(hot).toMatchObject({ reason: "breaker-open" })
    expect(batch).toMatchObject({ reason: "breaker-open" })
  })
})

describe("assembly by id", () => {
  test("shuffled responses still map to the right answer", () => {
    const answers = new Map([
      ["c", "third"],
      ["a", "first"],
      ["b", "second"],
    ])
    expect([...assembleById(["a", "b", "c"], answers).entries()]).toEqual([
      ["a", "first"],
      ["b", "second"],
      ["c", "third"],
    ])
    expect(assembleById(["a", "missing"], answers).has("missing")).toBe(false)
  })
})

describe("hot and batch isolation", () => {
  test("the hot path finishes while a batch slot is occupied", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    let started: () => void = () => {}
    let release: () => void = () => {}
    const batchStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const batchGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const batch = governor.runBatch("batch", 1, async () => {
      started()
      await batchGate
      return "batch"
    })
    await batchStarted

    const hot = await governor.runHot("hot", 1, async () => "hot")
    expect(hot).toBe("hot")

    release()
    expect(await batch).toBe("batch")
  })
})

describe("budget reservation", () => {
  const budgetConfig: GovernorConfig = {
    ...config,
    monthlyTokenBudget: 100,
    hotReserveFraction: 0,
    breakerFailures: 1,
    breakerCooldownMs: 1_000,
  }

  test("a call that fails after sending still counts its estimate, and the cap is not overrun", async () => {
    const governor = createGovernor({ config: () => budgetConfig, store: memStore() })
    const failing = async (): Promise<string> => {
      throw new Error("sent then broke")
    }
    await Promise.allSettled([1, 2, 3, 4, 5].map((n) => governor.runHot(`k${n}`, 30, failing)))

    // Five 30-token calls were attempted against a 100-token cap; only three could reserve.
    expect(governor.state().tokensSpent).toBe(90)
    expect(governor.state().tokensSpent).toBeLessThanOrEqual(100)
  })

  test("an exhausted budget does not strand the half-open probe", async () => {
    let clock = 0
    const store = resettableStore()
    const governor = createGovernor({ config: () => budgetConfig, store, now: () => clock })
    // Spend the budget while the breaker is closed, then open the breaker.
    await governor.runHot("fill", 100, async () => "ok")
    governor.recordFailure("network")
    expect(governor.state().breaker).toBe("open")

    // Cooldown has passed, but the budget is gone: the call must be refused on the budget, not by
    // reserving the half-open probe and never releasing it.
    clock = 1_000
    const blocked = await governor.runHot("blocked", 50, async () => "never").catch((error: unknown) => error)
    expect(blocked).toMatchObject({ reason: "budget-exhausted" })

    // The budget comes back: the probe must still be reservable, so the circuit recovers.
    store.reset()
    const recovered = await governor.runHot("recovered", 10, async () => "ok").catch((error: unknown) => error)
    expect(recovered).toBe("ok")
    governor.recordSuccess()
    expect(governor.state().breaker).toBe("closed")
  })
})

describe("outcome feedback and live budget (AH-A06)", () => {
  test("five joiners of one failing flight count one breaker failure, not five", async () => {
    const governor = createGovernor({ config: () => ({ ...config, breakerFailures: 2 }), store: memStore() })
    let calls = 0
    const failing = async (): Promise<string> => {
      calls += 1
      await Promise.resolve()
      throw new DecisionUnavailable("timeout")
    }
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => governor.runHot("same", 1, failing)))

    expect(calls).toBe(1)
    expect(results.every((result) => result.status === "rejected")).toBe(true)
    // One failure against a threshold of two: still closed. One more opens it, so the count was one.
    expect(governor.state().breaker).toBe("closed")
    await governor.runHot("other", 1, failing).catch(() => undefined)
    expect(governor.state().breaker).toBe("open")
  })

  test("a degraded answer shared by joiners backs the limiter off once", async () => {
    const governor = createGovernor({ config: () => config, store: memStore() })
    const degraded = async () => {
      await Promise.resolve()
      return { degraded: true, degradedReason: "rate-limited" as const }
    }
    await Promise.all([1, 2, 3].map(() => governor.runBatch("same", 1, degraded)))
    // 4 halves to 2 once; three recordings would have floored it at 1.
    expect(governor.state().concurrency).toBe(2)
  })

  test("a budget changed in the live config is enforced without rebuilding the governor", async () => {
    let live: GovernorConfig = { ...config, monthlyTokenBudget: 100, hotReserveFraction: 0 }
    const governor = createGovernor({ config: () => live, store: memStore() })
    expect(await governor.runHot("first", 50, async () => "ok")).toBe("ok")

    live = { ...live, monthlyTokenBudget: 40 }
    const refused = await governor.runHot("second", 10, async () => "never").catch((error: unknown) => error)
    expect(refused).toMatchObject({ reason: "budget-exhausted" })

    live = { ...live, monthlyTokenBudget: 1_000 }
    expect(await governor.runHot("third", 10, async () => "ok")).toBe("ok")
  })

  test("an open breaker refuses without writing to usage", async () => {
    const base = memStore()
    let writes = 0
    const store: GovernorStore = {
      adaptiveUsage: base.adaptiveUsage,
      addAdaptiveUsage: (month, tokens, calls, at) => {
        writes += 1
        base.addAdaptiveUsage(month, tokens, calls, at)
      },
    }
    const governor = createGovernor({ config: () => config, store })
    governor.recordFailure("network")
    governor.recordFailure("network")
    governor.recordFailure("network")
    expect(governor.state().breaker).toBe("open")

    const refused = await governor.runHot("blocked", 10, async () => "never").catch((error: unknown) => error)
    expect(refused).toMatchObject({ reason: "breaker-open" })
    expect(writes).toBe(0)
    expect(governor.state().tokensSpent).toBe(0)
  })
})
