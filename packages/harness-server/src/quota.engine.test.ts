import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { DEEPSEEK_BALANCE, OPENROUTER_KEY } from "./quota/fixtures"
import { createQuotaPoller } from "./quota/poller"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * Provider quotas (UL-07) on the pinned OpenCode 2 engine: a key stored in the engine is read by
 * FlupCode's quota plugin, inside the engine, against a fake provider on the loopback that answers in
 * the documented shape; harness-server only ever sees the provider's answer, keeps it as samples and
 * serves it. A provider with no connection is never called. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/quota.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const KEY = "sk-or-v1-quota-engine-test"
const model = startModel()
const seen: Array<{ path: string; authorization: string | null }> = []
const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname
    seen.push({ path, authorization: request.headers.get("authorization") })
    if (path === "/api/v1/key") return Response.json(OPENROUTER_KEY)
    if (path === "/user/balance") return Response.json(DEEPSEEK_BALANCE)
    return new Response("not found", { status: 404 })
  },
})
let engine: Engine
let repository: SqliteRoutineRepository
let scheduler: RoutineScheduler

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  engine = await startEngine({
    modelUrl: model.url,
    env: { OPENCODE_PURE: undefined, FLUPCODE_QUOTA_ORIGIN: `http://127.0.0.1:${provider.port}` },
    flupcodePlugins: true,
  })
  scheduler = new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization })
  // The key goes in the way the app's provider settings put it: the engine's own connect route.
  await eventually(async () => {
    const response = await engineCall("POST", "/api/integration/openrouter/connect/key", { key: KEY })
    return response.status === 204
  })
}, 180_000)

afterAll(async () => {
  await scheduler?.stopAll()
  repository?.close()
  await engine?.stop()
  provider.stop(true)
  model.stop()
})

describe.skipIf(!run)("provider quotas on OpenCode 2 (UL-07)", () => {
  test("2.0.18 has no route that reads a stored credential back", async () => {
    const integration = (await (await engineCall("GET", "/api/integration/openrouter")).json()) as {
      data: { connections: Array<{ type: string; id?: string; method?: string }> }
    }
    const connection = integration.data.connections.find((entry) => entry.type === "credential")!
    expect(connection.method).toBe("key")
    expect((await engineCall("GET", `/api/credential/${connection.id}`)).status).toBe(404)
    expect((await engineCall("GET", "/api/credential")).status).toBe(404)
  })

  test("a connected provider's windows are read in the engine, stored and served; the other is never called", async () => {
    // Short waits, so a read tried before the plugin loaded is tried again within the test.
    const quotas = createQuotaPoller({ engine: scheduler.engine, repository, intervalMs: 50, maxBackoffMs: 200 })
    // The plugin registers its RPC once the engine has loaded it.
    await eventually(async () => {
      await quotas.tick()
      return quotas.report()[0]?.sampledAt != null
    })
    // Only OpenRouter has a connection: DeepSeek has an adapter and is never called.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((hit) => hit.path === "/api/v1/key" && hit.authorization === `Bearer ${KEY}`)).toBe(true)

    const handler = createHarnessHandler(repository, scheduler, { token: "ui-token", quotas })
    const response = await handler(
      new Request("http://127.0.0.1/harness/quotas", { headers: { authorization: "Bearer ui-token", host: "127.0.0.1" } }),
    )
    const text = await response.text()
    // The key, and OpenRouter's shortened copy of it, never reach the server's answer.
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(OPENROUTER_KEY.data.label)
    const body = JSON.parse(text) as { data: Array<{ providerID: string; sampledAt: number; windows: Array<{ id: string; used: number; limit: number; forecast: unknown }> }> }
    expect(body.data.map((entry) => entry.providerID)).toEqual(["openrouter"])
    expect(body.data[0]!.windows.find((window) => window.id === "key-limit")).toMatchObject({
      used: 7.5,
      limit: 20,
      // Readings seconds apart: a pace needs a longer span of them.
      forecast: null,
    })
    expect(new Set(repository.quotaSamples("openrouter", 0).map((sample) => sample.window.id))).toEqual(
      new Set(["key-limit", "free-requests"]),
    )
    expect(repository.quotaSamples("deepseek", 0)).toEqual([])
  })
})

function engineCall(method: string, path: string, body?: unknown) {
  return fetch(engine.url + path, {
    method,
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function eventually(check: () => Promise<boolean>) {
  for (const _ of Array.from({ length: 80 })) {
    if (await check().catch(() => false)) return
    await Bun.sleep(250)
  }
  throw new Error("Timed out waiting for the engine")
}
