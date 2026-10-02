import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { summariseUsage } from "./usage"
import { billingOf, createUsagePricing } from "./usage-pricing"
import { createUsageReconciler } from "./usage-reconciler"

/**
 * What the pinned engine tells the server about prices and connections (UL-05), and the ledger rows
 * that come out of it. A provider in the user's config declares three models: one with a price, one
 * with none and one priced at $0. The engine reports $0 for both of the last two, and only its
 * catalog tells them apart. It starts an engine, so it only runs when asked, as CI's engine job does:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/usage-pricing.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let contract: ContractEngine
let engine: Engine
let client: ReturnType<typeof OpenCode.make>

const declared = (cost?: { input: number; output: number }) => ({
  name: "Declared",
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  ...(cost ? { cost } : {}),
})

beforeAll(async () => {
  if (!run) return
  contract = await startEngine({
    modelUrl: model.url,
    // Written where the custom-provider form writes it, in the 1.x shape both lines load.
    prepare: async (home) => {
      mkdirSync(join(home, ".config/opencode"), { recursive: true })
      writeFileSync(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          provider: {
            custom: {
              name: "Custom",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "custom-key", baseURL: model.url },
              models: {
                priced: declared({ input: 1000, output: 2000 }),
                unpriced: declared(),
                free: declared({ input: 0, output: 0 }),
              },
            },
          },
        }),
      )
    },
  })
  engine = new Engine(contract.url, contract.authorization)
  client = OpenCode.make({ baseUrl: contract.url, headers: { authorization: contract.authorization } })
}, 120_000)

afterAll(async () => {
  await contract?.stop()
  model.stop()
})

/** The catalog once the engine has loaded the config's models: it lists none for a moment after it starts. */
const loaded = async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const catalog = await engine.usageCatalog(contract.project)
    if (catalog.models.some((entry) => entry.providerID === "custom")) return catalog
    await Bun.sleep(250)
  }
  throw new Error("The engine never listed the config's models")
}

const idle = async (sessionID: string) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const info = await client.session.get({ sessionID })
    if (info.time.idle && !(sessionID in (await client.session.active()))) return info
    await Bun.sleep(200)
  }
  throw new Error(`${sessionID} did not go idle`)
}

describe.skipIf(!run)("ledger pricing on an OpenCode 2 engine", () => {
  test("the catalog says which models have a price, and how each provider is connected", async () => {
    const catalog = await loaded()
    const custom = catalog.models.filter((entry) => entry.providerID === "custom")
    expect(custom.toSorted((a, b) => a.modelID.localeCompare(b.modelID))).toEqual([
      { providerID: "custom", modelID: "free", priced: true },
      { providerID: "custom", modelID: "priced", priced: true },
      { providerID: "custom", modelID: "unpriced", priced: false },
    ])
    // The config's key is reported as present, never handed over; its host is this machine.
    const provider = catalog.providers.find((entry) => entry.providerID === "custom")
    expect(provider).toMatchObject({ configKey: true, baseURL: model.url })
    expect(JSON.stringify(catalog)).not.toContain("custom-key")
    expect(billingOf(catalog, "custom")).toBe("local")

    // A stored key is a connection the engine reports by its method.
    await client.integration.connect.key({ integrationID: "anthropic", key: "sk-ant-not-a-real-key" })
    const connected = await engine.usageCatalog(contract.project)
    expect(connected.integrations.find((entry) => entry.integrationID === "anthropic")?.connections).toEqual(["key"])
    expect(billingOf(connected, "anthropic")).toBe("metered")
  })

  test("a step on a model nobody priced is stored unpriced; one on a free model stays $0", async () => {
    await loaded()
    const repository = new SqliteRoutineRepository(":memory:")
    const ids: Record<string, string> = {}
    for (const modelID of ["unpriced", "free", "priced"]) {
      const { id } = await engine.createSession({ directory: contract.project, title: modelID })
      model.push({ type: "text", text: "Done" })
      await engine.prompt({ sessionID: id, text: "go", model: { providerID: "custom", id: modelID } })
      const info = await idle(id)
      // The engine itself cannot tell the first two apart.
      if (modelID !== "priced") expect(info.cost).toBe(0)
      ids[modelID] = id
    }
    const pricing = createUsagePricing({ engine, repository })
    const reconciler = createUsageReconciler({ repository, engine, classify: pricing.classify, log: () => {} })
    await reconciler.sweep()

    const [unpriced] = repository.usageEvents(ids.unpriced!)
    expect(unpriced).toMatchObject({ costBasis: "unpriced", billing: "local", modelID: "unpriced" })
    expect(unpriced).not.toHaveProperty("costUSD")
    expect(repository.usageEvents(ids.free!)[0]).toMatchObject({
      costBasis: "engine-list-price",
      costUSD: 0,
      billing: "local",
    })
    expect(repository.usageEvents(ids.priced!)[0]).toMatchObject({ costBasis: "engine-list-price", billing: "local" })
    expect(repository.usageEvents(ids.priced!)[0]!.costUSD).toBeGreaterThan(0)

    // Read back, the unpriced step is counted as unpriced and adds nothing to the money.
    const summary = summariseUsage(repository.usageTotals({ groupBy: "model" }), { groupBy: "model" })
    const group = summary.groups.find((entry) => entry.fields.modelID === "unpriced")
    expect(group).toMatchObject({ money: [], unpriced: { events: 1 } })
    repository.close()
  })
})
