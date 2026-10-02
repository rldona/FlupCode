import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { UsageEvent } from "./usage-ledger"
import { billingOf, createUsagePricing, type UsageCatalog } from "./usage-pricing"
import { createUsageReconciler } from "./usage-reconciler"

/**
 * What the server can tell of a ledger row's money (UL-05): the basis from whether the engine has a
 * price for the model, the billing from how the provider is connected, and nothing it cannot tell.
 * The catalogs are shaped as the pinned engine answers (verified in `usage-pricing.engine.test.ts`).
 */

const catalog = (over: Partial<UsageCatalog> = {}): UsageCatalog => ({
  providers: [
    { providerID: "anthropic", configKey: false },
    { providerID: "openai", configKey: false },
    { providerID: "github-copilot", configKey: false },
    { providerID: "digitalocean", configKey: false },
    { providerID: "custom", configKey: true, baseURL: "https://llm.example.com/v1" },
    { providerID: "ollama", configKey: false, baseURL: "http://localhost:11434/v1" },
    { providerID: "lan", configKey: false, baseURL: "http://127.0.0.1:1234/v1" },
    { providerID: "loose", configKey: false },
  ],
  models: [
    { providerID: "anthropic", modelID: "sonnet", priced: true },
    { providerID: "custom", modelID: "mine", priced: false },
    { providerID: "custom", modelID: "free", priced: true },
    { providerID: "ollama", modelID: "llama", priced: false },
  ],
  integrations: [
    { integrationID: "anthropic", connections: ["key"] },
    { integrationID: "openai", connections: ["oauth"] },
    { integrationID: "github-copilot", connections: [] },
    { integrationID: "digitalocean", connections: ["oauth"] },
    { integrationID: "custom", connections: [] },
  ],
  ...over,
})

const step = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: `ses_1:step:${crypto.randomUUID()}`,
  kind: "step",
  sessionID: "ses_1",
  providerID: "anthropic",
  modelID: "sonnet",
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  costUSD: 0.02,
  costBasis: "engine-list-price",
  billing: "unknown",
  endedAt: 1_000_000,
  directory: "/work/a",
  ...over,
})

/** A clock the test moves, and an engine whose catalog the test sets and may break. */
function setup(answer: () => UsageCatalog = () => catalog()) {
  const clock = { now: 1_000_000 }
  const asked: Array<string | undefined> = []
  const repository = new SqliteRoutineRepository(":memory:")
  const engine = {
    failing: false,
    usageCatalog: async (directory?: string) => {
      asked.push(directory)
      if (engine.failing) throw new Error("engine down")
      return answer()
    },
  }
  const pricing = createUsagePricing({ engine, repository, ttlMs: 60_000, now: () => clock.now })
  return { clock, asked, repository, engine, pricing }
}

describe("billingOf", () => {
  test("follows how the provider is connected, and says unknown where that does not tell", () => {
    const answer = catalog({
      integrations: [...catalog().integrations, { integrationID: "loose", connections: ["key", "oauth"] }],
    })
    expect(billingOf(answer, "anthropic")).toBe("metered")
    // ChatGPT Pro/Plus is the only OpenAI sign-in; Copilot has no pay-per-token plan at all.
    expect(billingOf(answer, "openai")).toBe("subscription")
    expect(billingOf(answer, "github-copilot")).toBe("subscription")
    // An OAuth account may be billed per use or be a plan: the engine does not say which.
    expect(billingOf(answer, "digitalocean")).toBe("unknown")
    // A key in the provider's own config, and nothing stored, is still a key.
    expect(billingOf(answer, "custom")).toBe("metered")
    expect(billingOf(answer, "ollama")).toBe("local")
    expect(billingOf(answer, "lan")).toBe("local")
    // Two connections that disagree: which one paid is not recorded.
    expect(billingOf(answer, "loose")).toBe("unknown")
    expect(billingOf(answer, "nobody")).toBe("unknown")
  })

  test("an environment key is metered", () => {
    expect(
      billingOf(catalog({ integrations: [{ integrationID: "anthropic", connections: ["env"] }] }), "anthropic"),
    ).toBe("metered")
  })
})

describe("classify", () => {
  test("a $0 row of a model nobody priced is unpriced, without the $0", async () => {
    const { pricing, repository } = setup()
    const [mine, free, paid] = await pricing.classify([
      step({ providerID: "custom", modelID: "mine", costUSD: 0 }),
      step({ providerID: "custom", modelID: "free", costUSD: 0 }),
      // A cost means the model had a price when the row happened, whatever the catalog says now.
      step({ providerID: "custom", modelID: "mine", costUSD: 0.5 }),
    ])
    expect(mine).toMatchObject({ costBasis: "unpriced" })
    expect(mine).not.toHaveProperty("costUSD")
    expect(free).toMatchObject({ costBasis: "engine-list-price", costUSD: 0 })
    expect(paid).toMatchObject({ costBasis: "engine-list-price", costUSD: 0.5 })
    repository.close()
  })

  test("billing is stamped on what happened while the server watched that connection, not before", async () => {
    const { pricing, clock, repository } = setup()
    const [now, justBefore, longBefore] = await pricing.classify([
      step({ endedAt: clock.now }),
      step({ endedAt: clock.now - 30_000 }),
      step({ endedAt: clock.now - 3_600_000 }),
    ])
    expect(now!.billing).toBe("metered")
    expect(justBefore!.billing).toBe("metered")
    // A backfilled row from an hour before: the key may not have been the connection then.
    expect(longBefore!.billing).toBe("unknown")
    // A step without any time cannot be placed, and one that already says its billing keeps it.
    const [timeless, said] = await pricing.classify([
      step({ endedAt: undefined, startedAt: undefined }),
      step({ billing: "subscription" }),
    ])
    expect(timeless!.billing).toBe("unknown")
    expect(said!.billing).toBe("subscription")
    repository.close()
  })

  test("a connection that changed starts over: the rows from before the change are not given the new one", async () => {
    let answer = catalog()
    const { pricing, clock, repository } = setup(() => answer)
    await pricing.classify([step()])
    answer = catalog({ integrations: [{ integrationID: "anthropic", connections: ["oauth"] }] })
    clock.now += 10 * 60_000
    const [after, before] = await pricing.classify([
      step({ endedAt: clock.now }),
      step({ endedAt: clock.now - 5 * 60_000 }),
    ])
    // Anthropic's OAuth is not one of the known plans, so the new connection reads as unknown.
    expect(after!.billing).toBe("unknown")
    expect(before!.billing).toBe("unknown")
    repository.close()
  })

  test("the catalog is asked once per folder and refresh, and an engine that fails leaves rows as they came", async () => {
    const { pricing, clock, asked, engine, repository } = setup()
    await pricing.classify([step(), step(), step({ directory: "/work/b" })])
    expect(asked).toEqual(["/work/a", "/work/b"])
    engine.failing = true
    clock.now += 61_000
    const row = step({ providerID: "custom", modelID: "mine", costUSD: 0, endedAt: clock.now })
    expect(await pricing.classify([row])).toEqual([row])
    repository.close()
  })

  test("rows stored before the server knew a model has no price are re-labelled once, only the $0 ones", async () => {
    const { pricing, repository } = setup()
    const old = [
      step({ id: "a", providerID: "custom", modelID: "mine", costUSD: 0 }),
      step({ id: "b", providerID: "custom", modelID: "mine", costUSD: 0.3 }),
      step({ id: "c", providerID: "custom", modelID: "free", costUSD: 0 }),
    ]
    repository.recordUsage({ events: old, tools: [] })
    await pricing.classify([step()])
    const stored = Object.fromEntries(repository.usageEvents("ses_1").map((event) => [event.id, event]))
    expect(stored.a).toMatchObject({ costBasis: "unpriced" })
    expect(stored.a).not.toHaveProperty("costUSD")
    expect(stored.b).toMatchObject({ costBasis: "engine-list-price", costUSD: 0.3 })
    expect(stored.c).toMatchObject({ costBasis: "engine-list-price", costUSD: 0 })
    repository.close()
  })
})

describe("where classification runs", () => {
  test("the ingest stores the classified rows", async () => {
    const { pricing, repository } = setup()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { pluginToken: "plugin-token", usagePricing: pricing })
    const response = await handler(
      new Request("http://127.0.0.1:4097/harness/usage/events", {
        method: "POST",
        headers: { authorization: "Bearer plugin-token", "content-type": "application/json" },
        body: JSON.stringify({ events: [step({ id: "live", providerID: "custom", modelID: "mine", costUSD: 0 })] }),
      }),
    )
    expect(response.status).toBe(200)
    expect(repository.usageEvents("ses_1")).toEqual([
      expect.objectContaining({ id: "live", costBasis: "unpriced", billing: "metered" }),
    ])
    repository.close()
  })

  test("the reconciler stores the classified rows", async () => {
    const { pricing, repository } = setup()
    const reconciler = createUsageReconciler({
      repository,
      engine: {
        sessionsUpdatedSince: async () => [{ id: "ses_1", updated: 5, busy: false }],
        sessionUsage: async () => ({ events: [step({ id: "kept", providerID: "openai", modelID: "gpt" })], tools: [] }),
      },
      classify: pricing.classify,
      log: () => {},
    })
    await reconciler.sweep()
    expect(repository.usageEvents("ses_1")).toEqual([expect.objectContaining({ id: "kept", billing: "subscription" })])
    repository.close()
  })
})
