import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { EngineError } from "./error"
import { createV2Domains } from "./v2"

/**
 * Models, providers and integrations through the OpenCode 2 adapter against a real 2.x engine
 * (V2-25): a keyless custom provider is listed, a key connects a catalog provider and disconnecting
 * it takes its models away, and an OAuth sign-in starts and is cancelled. OAuth carried through to a
 * token is proven with the same integration API by the MCP test. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-providers.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    config: {
      provider: {
        keyless: {
          name: "Keyless",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${model.url}/v1` },
          models: { "free-model": { name: "Free model" } },
        },
      },
    },
  })
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  domains = createV2Domains(engine.url)
})

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("providers on the OpenCode 2 adapter", () => {
  test("a keyless custom provider is listed, with its model, as a config provider", async () => {
    const models = await until(
      () => domains.model.list(),
      (result) => result.data.some((item) => item.providerID === "keyless"),
    )
    expect(models.data.find((item) => item.providerID === "keyless")).toMatchObject({
      id: "free-model",
      name: "Free model",
      enabled: true,
      api: { id: "free-model", type: "aisdk" },
    })
    const directory = await domains.provider.directory()
    expect(directory.all.find((item) => item.id === "keyless")).toMatchObject({
      name: "Keyless",
      source: "config",
      models: { "free-model": {} },
    })
    expect(directory.connected).toContain("keyless")
  })

  test("a key connects a catalog provider, and disconnecting it takes its models away", async () => {
    const before = await domains.integration.list()
    const openai = before.data.find((item) => item.id === "openai")
    expect(openai?.methods.map((method) => method.type)).toEqual(expect.arrayContaining(["key", "env", "oauth"]))
    expect((await domains.provider.directory()).all.find((item) => item.id === "openai")?.env).toContain(
      "OPENAI_API_KEY",
    )

    // What the app does when the reader saves a key: an integration credential.
    await domains.integration.connectKey({ integrationID: "openai", key: "sk-contract", label: "openai" })
    const connected = await until(
      () => domains.model.list(),
      (result) => result.data.some((item) => item.providerID === "openai"),
    )
    expect(connected.data.length).toBeGreaterThan(1)

    const credential = (await domains.integration.list()).data
      .find((item) => item.id === "openai")
      ?.connections.find((connection) => connection.type === "credential")
    expect(credential).toBeDefined()
    await domains.integration.disconnect(credential!.id)
    await until(
      () => domains.model.list(),
      (result) => !result.data.some((item) => item.providerID === "openai"),
    )
  })

  test("an OAuth sign-in starts with a URL to open, is pending, and can be cancelled", async () => {
    const started = await domains.integration.oauth({ integrationID: "openai", methodID: "chatgpt-browser" })
    expect(started.data.url).toMatch(/^https:\/\//)
    expect((await domains.integration.attempt.status(started.data.attemptID)).data.status).toBe("pending")
    await domains.integration.attempt.cancel(started.data.attemptID)
    const after = await domains.integration.attempt.status(started.data.attemptID).catch((cause: unknown) => cause)
    expect(after).toBeInstanceOf(EngineError)
  })

  test("no answer carries a key", async () => {
    await domains.integration.connectKey({ integrationID: "keyless", key: "sk-secret-contract" })
    const answers = JSON.stringify([
      await domains.model.list(),
      await domains.provider.list(),
      await domains.provider.directory(),
      await domains.integration.list(),
    ])
    expect(answers).not.toContain("sk-secret-contract")
    expect(answers).not.toContain("apiKey")
  })
})

/** The first answer `match` accepts, asked again until the engine's catalog settles (30s at most). */
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (match(value)) return value
    if (Date.now() > deadline) throw new Error(`Never matched: ${JSON.stringify(value).slice(0, 500)}`)
    await Bun.sleep(200)
  }
}
