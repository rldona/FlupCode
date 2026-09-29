import { describe, expect, test } from "bun:test"
import { assembleById } from "./assembly"
import { createGovernor } from "./governor"
import type { GovernorConfig, GovernorStore } from "./governor"

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
    const governor = createGovernor({ config, store: memStore() })
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
    const governor = createGovernor({ config, store: memStore() })
    governor.recordRateLimit()

    const results = await Promise.all([1, 2, 3, 4, 5].map((value) => governor.runBatch(`k${value}`, 1, async () => value)))
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(governor.state().inflight).toBe(0)
  })
})

describe("single-flight", () => {
  test("two concurrent identical requests produce exactly one outbound call", async () => {
    const governor = createGovernor({ config, store: memStore() })
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
    const governor = createGovernor({ config, store: memStore() })
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
    const governor = createGovernor({ config: budgetConfig, store: memStore() })
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
    const governor = createGovernor({ config: budgetConfig, store, now: () => clock })
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
