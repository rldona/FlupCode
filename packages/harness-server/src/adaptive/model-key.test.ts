import { afterEach, describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { createVault } from "../vault"
import { createAdaptiveEgressGuard } from "./egress"
import { resolveAdaptiveConfig } from "./config"
import { MODEL_KEY_NAME, createModelKey } from "./model-key"

// Test values only: none of these is a real key.
const STORED = "stored-test-key-0001"
const FROM_ENV = "env-test-key-0002"
const ENDPOINT = "https://api.typesafe.test/v1/systemone"

const repositories: SqliteRoutineRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
})

const setup = (input: { env?: NodeJS.ProcessEnv; vault?: boolean; endpoint?: () => string } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const vault = input.vault === false ? undefined : createVault({ store: repository, key: Buffer.alloc(32, 7) })
  const env = input.env ?? {}
  const key = createModelKey({ env, vault, endpoint: input.endpoint ?? (() => ENDPOINT) })
  return { repository, vault, env, key }
}

describe("the predictive model's key", () => {
  test("the environment keeps precedence over a stored key, and both are read on each call", async () => {
    const { env, key } = setup()
    expect(key.status()).toEqual({ source: "none", storable: true })
    expect(await key.resolve()).toBeUndefined()

    key.set(STORED)
    expect(key.status()).toEqual({ source: "stored", storable: true })
    expect(await key.resolve()).toBe(STORED)

    env.TYPESAFE_API_KEY = FROM_ENV
    expect(key.status()).toEqual({ source: "env", storable: true })
    expect(await key.resolve()).toBe(FROM_ENV)

    delete env.TYPESAFE_API_KEY
    expect(await key.resolve()).toBe(STORED)
    key.remove()
    expect(key.status().source).toBe("none")
    expect(await key.resolve()).toBeUndefined()
  })

  test("a stored key is bound to the endpoint's origin, under its fixed name", async () => {
    const endpoint = { current: ENDPOINT }
    const { vault, key } = setup({ endpoint: () => endpoint.current })
    key.set(STORED)
    expect(vault!.list()).toEqual([expect.objectContaining({ name: MODEL_KEY_NAME, origin: "https://api.typesafe.test" })])
    // Pointed elsewhere, the key is not sent to the new host.
    endpoint.current = "https://elsewhere.test/v1"
    expect(key.status().source).toBe("none")
    expect(await key.resolve()).toBeUndefined()
  })

  test("without a vault only the environment can hold it, and saving says so", async () => {
    const { key } = setup({ vault: false, env: { TYPESAFE_API_KEY: ` ${FROM_ENV} ` } })
    expect(key.status()).toEqual({ source: "env", storable: false })
    expect(await key.resolve()).toBe(FROM_ENV)
    expect(() => key.set(STORED)).toThrow(expect.objectContaining({ code: "vault-unavailable" }))
  })

  test("the redaction secrets cover a stored key, saved after the guard was built", () => {
    const { vault, key } = setup()
    const egress = createAdaptiveEgressGuard({
      config: () => resolveAdaptiveConfig({ block: {}, env: {} }),
      secrets: () => vault!.secrets(),
    })
    key.set(STORED)
    const redacted = JSON.stringify(egress.redact({ note: `key=${STORED}` }))
    expect(redacted).not.toContain(STORED)
    expect(redacted).toContain("[REDACTED]")
  })
})

describe("the model key routes", () => {
  const handlerWith = (input: { token?: string; vault?: boolean; env?: NodeJS.ProcessEnv } = {}) => {
    const { repository, key } = setup(input)
    const handler = createHarnessHandler(repository, new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }), {
      modelKey: key,
      ...(input.token === undefined ? {} : { token: input.token }),
    })
    return { handler, key }
  }
  const call = (
    handler: ReturnType<typeof handlerWith>["handler"],
    method: string,
    body?: unknown,
    token: string | null = "t",
  ) =>
    handler(
      new Request("http://127.0.0.1/harness/adaptive/model-key", {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  test("every method needs the writer's bearer; without one configured the route does not exist", async () => {
    const guarded = handlerWith({ token: "t" })
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await call(guarded.handler, method, { confirm: true, key: STORED }, null)).status).toBe(403)
      expect((await call(guarded.handler, method, { confirm: true, key: STORED }, "wrong")).status).toBe(403)
    }
    expect(guarded.key.status().source).toBe("none")

    const open = handlerWith()
    expect((await call(open.handler, "GET", undefined, null)).status).toBe(404)
    expect((await call(open.handler, "PUT", { confirm: true, key: STORED }, null)).status).toBe(404)
    const health = await (await open.handler(new Request("http://127.0.0.1/harness/health"))).json()
    expect(health.capabilities).not.toContain("adaptive-model-key")
  })

  test("health announces the capability only with the bearer", async () => {
    const { handler } = handlerWith({ token: "t" })
    const health = await (await handler(new Request("http://127.0.0.1/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-model-key")
  })

  test("saving and removing need confirmation, and no answer ever carries the key", async () => {
    const { handler, key } = handlerWith({ token: "t" })
    const unconfirmed = await call(handler, "PUT", { key: STORED })
    expect(unconfirmed.status).toBe(422)
    expect((await unconfirmed.json()).code).toBe("confirmation-required")
    expect(key.status().source).toBe("none")

    const blank = await call(handler, "PUT", { key: "   ", confirm: true })
    expect((await blank.json()).code).toBe("invalid-key")

    const saved = await call(handler, "PUT", { key: STORED, confirm: true })
    const savedText = await saved.text()
    expect(saved.status).toBe(200)
    expect(JSON.parse(savedText)).toEqual({ data: { source: "stored", storable: true } })
    expect(savedText).not.toContain(STORED)

    const status = await (await call(handler, "GET")).text()
    expect(JSON.parse(status)).toEqual({ data: { source: "stored", storable: true } })
    expect(status).not.toContain(STORED)

    expect((await call(handler, "DELETE", {})).status).toBe(422)
    expect(key.status().source).toBe("stored")
    const removed = await call(handler, "DELETE", { confirm: true })
    expect(await removed.json()).toEqual({ data: { source: "none", storable: true } })
  })

  test("the status reports the environment's key without echoing it", async () => {
    const { handler } = handlerWith({ token: "t", env: { TYPESAFE_API_KEY: FROM_ENV } })
    const text = await (await call(handler, "GET")).text()
    expect(JSON.parse(text)).toEqual({ data: { source: "env", storable: true } })
    expect(text).not.toContain(FROM_ENV)
  })

  test("without a vault a save is refused with a code the panel can explain", async () => {
    const { handler } = handlerWith({ token: "t", vault: false })
    expect(await (await call(handler, "GET")).json()).toEqual({ data: { source: "none", storable: false } })
    const refused = await call(handler, "PUT", { key: STORED, confirm: true })
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe("vault-unavailable")
  })
})
