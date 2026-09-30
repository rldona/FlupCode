import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { createAdaptiveConfig } from "./config"
import { createAdaptiveConfigSurface } from "./config-surface"
import type { AdaptiveConfigSurface } from "./config-surface"
import type { RuntimeKind } from "./runtime"
import type { RuntimeCapabilities } from "./runtime"

const TOKEN = "test-token"

const capabilities: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: 0,
}

let root = ""
let config = ""
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

const surface = (
  options: {
    runtime?: RuntimeKind
    env?: NodeJS.ProcessEnv
    adaptiveTokenPresent?: boolean
    canWrite?: boolean
    block?: Record<string, unknown>
  } = {},
) =>
  createAdaptiveConfigSurface({
    config: createAdaptiveConfig({ read: () => options.block ?? {}, env: {} }),
    runtime: () => ({ runtime: options.runtime ?? "legacy", degraded: false, checkedAt: 0 }),
    capabilities: () => capabilities,
    repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
    canWrite: options.canWrite ?? true,
    adaptiveTokenPresent: options.adaptiveTokenPresent ?? true,
    ...(options.env ? { env: options.env } : {}),
  })

/** A handler over a throwaway repository, with the settings surface wired in like the server does. */
const open = (options: { adaptiveConfig?: AdaptiveConfigSurface; token?: string } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return createHarnessHandler(repository, scheduler, {
    ...(options.token ? { token: options.token } : {}),
    ...(options.adaptiveConfig ? { adaptiveConfig: options.adaptiveConfig } : {}),
  })
}

const call = (
  handler: ReturnType<typeof createHarnessHandler>,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) =>
  handler(
    new Request(`http://x${path}`, {
      method: init.method ?? "GET",
      headers: init.token === undefined ? {} : { authorization: `Bearer ${init.token}` },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-config-routes-"))
  config = join(root, "config")
  mkdirSync(config, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_CONFIG_HOME = join(root, "xdg")
  process.env.OPENCODE_TEST_HOME = join(root, "home")
})

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("GET /harness/adaptive/config", () => {
  test("answers the read model without a token, with canWrite false", async () => {
    const handler = open({ adaptiveConfig: surface({ canWrite: false }) })
    const response = await call(handler, "/harness/adaptive/config")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.canWrite).toBe(false)
    expect(body.data.effective.enabled).toBe(true)
    expect(Array.isArray(body.data.writable)).toBe(true)
    expect(body.data.source.enabled).toBe("default")
  })

  test("asks for the bearer when one is configured", async () => {
    const handler = open({ adaptiveConfig: surface(), token: TOKEN })
    expect((await call(handler, "/harness/adaptive/config")).status).toBe(403)
    expect((await call(handler, "/harness/adaptive/config", { token: "wrong" })).status).toBe(403)
    expect((await call(handler, "/harness/adaptive/config", { token: TOKEN })).status).toBe(200)
  })

  test("is an ordinary 404 when the surface was not built", async () => {
    const handler = open()
    expect((await call(handler, "/harness/adaptive/config")).status).toBe(404)
  })
})

describe("PATCH /harness/adaptive/config", () => {
  test("is a 404 when no bearer is configured", async () => {
    const handler = open({ adaptiveConfig: surface() })
    const response = await call(handler, "/harness/adaptive/config", { method: "PATCH", body: { patch: { shadow: false } } })
    expect(response.status).toBe(404)
  })

  test("a deeper path is not this route", async () => {
    const handler = open({ adaptiveConfig: surface(), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config/extra", {
      method: "PATCH",
      body: { patch: { shadow: false } },
      token: TOKEN,
    })
    expect(response.status).toBe(404)
  })

  test("requires the bearer when one is configured", async () => {
    const handler = open({ adaptiveConfig: surface(), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { shadow: false } },
      token: "wrong",
    })
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("invalid_token")
  })

  test("writes a switch and returns the resulting view with warnings", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(path, '{ "theme": "dark", "flupcode": { "adaptive": { "enabled": true } } }\n')
    const { globalAdaptiveBlock } = await import("../config-files")
    const live = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 40, calls: 2 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })
    const handler = open({ adaptiveConfig: live, token: TOKEN })

    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { context: { apply: true } } },
      token: TOKEN,
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.effective.context.apply).toBe(true)
    expect(body.data.usage).toMatchObject({ tokensSpent: 40, calls: 2 })
    expect(body.warnings).toEqual(["evaluation-gated"])
  })

  test("warns when relevance is enabled on a runtime that cannot act", async () => {
    const handler = open({ adaptiveConfig: surface({ runtime: "v2" }), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { relevance: { enabled: true } } },
      token: TOKEN,
    })
    expect(response.status).toBe(200)
    expect((await response.json()).warnings).toEqual(["runtime-inert"])
  })

  test("an action write and an adaptive write racing on one file both survive", async () => {
    const path = join(config, "opencode.jsonc")
    writeFileSync(path, '{ "theme": "dark", "flupcode": { "adaptive": {}, "actions": {} } }\n')
    const { globalAdaptiveBlock } = await import("../config-files")
    const { writeActionProfile } = await import("../action-config")
    const live = createAdaptiveConfigSurface({
      config: createAdaptiveConfig({ read: globalAdaptiveBlock, env: {} }),
      runtime: () => ({ runtime: "legacy", degraded: false, checkedAt: 0 }),
      capabilities: () => capabilities,
      repository: { adaptiveUsage: () => ({ tokens: 0, calls: 0 }), addAdaptiveUsage: () => {} },
      canWrite: true,
      adaptiveTokenPresent: true,
      env: {},
    })
    const handler = open({ adaptiveConfig: live, token: TOKEN })

    // Both writers share the one serial queue in `config-write.ts`; without it one read-modify-write
    // would start from the same text as the other and its edit would be lost.
    const [response, written] = await Promise.all([
      call(handler, "/harness/adaptive/config", {
        method: "PATCH",
        body: { patch: { enabled: false } },
        token: TOKEN,
      }),
      writeActionProfile({
        scope: "global",
        id: "keep",
        profile: {
          tool: "do_keep",
          kind: "browser",
          origin: "https://example.com",
          steps: [{ goto: "{{origin}}/" }],
        },
      }),
    ])

    expect(response.status).toBe(200)
    expect(written.path).toBe(path)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.theme).toBe("dark")
    expect(parsed.flupcode.adaptive.enabled).toBe(false)
    expect(parsed.flupcode.actions.keep.tool).toBe("do_keep")
  })
})

describe("refusals", () => {
  const patch = async (body: unknown, options: Parameters<typeof open>[0] = {}) => {
    const handler = open({ adaptiveConfig: surface(), token: TOKEN, ...options })
    return call(handler, "/harness/adaptive/config", { method: "PATCH", body, token: TOKEN })
  }

  test("unsupported-field", async () => {
    const response = await patch({ patch: { runtime: "v2" } })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: "unsupported-field", fields: ["runtime"] })
  })

  test("invalid-value", async () => {
    const response = await patch({ patch: { shadow: "off" } })
    expect((await response.json()).code).toBe("invalid-value")
  })

  test("confirmation-required", async () => {
    const response = await patch({ patch: { retention: { enabled: true } } })
    expect((await response.json())).toMatchObject({ code: "confirmation-required", fields: ["retention.enabled"] })
  })

  test("env-disabled", async () => {
    const handler = open({ adaptiveConfig: surface({ env: { FLUPCODE_ADAPTIVE_DISABLED: "1" } }), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { enabled: true } },
      token: TOKEN,
    })
    expect((await response.json()).code).toBe("env-disabled")
  })

  test("guard:no-adaptive-token", async () => {
    const handler = open({ adaptiveConfig: surface({ adaptiveTokenPresent: false }), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { relevance: { enabled: true } } },
      token: TOKEN,
    })
    expect((await response.json()).code).toBe("guard:no-adaptive-token")
  })

  test("guard:egress-allowlist-required with the missing fields", async () => {
    const response = await patch({ patch: { learning: { enabled: true } } })
    expect(await response.json()).toMatchObject({
      code: "guard:egress-allowlist-required",
      missing: ["egress.providers.jev.projects", "egress.providers.jev.kinds.skillReflection"],
    })
  })

  test("guard:egress-allowlist-required for Jev, with both missing leaves", async () => {
    const response = await patch({ patch: { jev: { enabled: true } }, confirm: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "guard:egress-allowlist-required",
      fields: ["jev.enabled"],
      missing: ["egress.providers.jev.projects", "egress.providers.jev.kinds"],
    })
  })

  test("confirmation-required for Jev once its allowlist is satisfied", async () => {
    const handler = open({
      adaptiveConfig: surface({ block: { egress: { projects: ["/p"], kinds: { completion: true } } } }),
      token: TOKEN,
    })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { jev: { enabled: true } } },
      token: TOKEN,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: "confirmation-required", fields: ["jev.enabled"] })
  })

  test("widening a provider's projects needs confirmation, and confirming writes it", async () => {
    const handler = open({
      adaptiveConfig: surface({ block: { egress: { providers: { "small-llm": { projects: ["/a"] } } } } }),
      token: TOKEN,
    })
    const widened = { egress: { providers: { "small-llm": { projects: ["/a", "/b"] } } } }
    const refused = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: widened },
      token: TOKEN,
    })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      code: "confirmation-required",
      fields: ["egress.providers.small-llm.projects"],
    })

    const accepted = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: widened, confirm: true },
      token: TOKEN,
    })
    expect(accepted.status).toBe(200)
    // The surface reads a fixed block in this test, so the write is asserted where it landed.
    const written = JSON.parse(readFileSync(join(config, "opencode.jsonc"), "utf8"))
    expect(written.flupcode.adaptive.egress.providers["small-llm"].projects).toEqual(["/a", "/b"])
    expect(written.flupcode.adaptive.egress.providers.jev).toBeUndefined()
  })

  test("widening a provider's kinds needs confirmation", async () => {
    const handler = open({
      adaptiveConfig: surface({ block: { egress: { projects: ["/p"], kinds: { completion: true } } } }),
      token: TOKEN,
    })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { egress: { providers: { jev: { kinds: { completion: true, failure: true } } } } } },
      token: TOKEN,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "confirmation-required",
      fields: ["egress.providers.jev.kinds"],
    })
  })

  test("a provider kind that is not a decision kind is an invalid-value", async () => {
    const response = await patch({ patch: { egress: { providers: { jev: { kinds: { nope: true } } } } }, confirm: true })
    expect(await response.json()).toMatchObject({ code: "invalid-value", fields: ["egress.providers.jev.kinds"] })
  })

  test("the legacy top-level egress keys are an unsupported-field", async () => {
    const response = await patch({ patch: { egress: { projects: ["/a"] } }, confirm: true })
    expect(await response.json()).toMatchObject({ code: "unsupported-field", fields: ["egress.projects"] })
  })

  // A directory at the candidate name is the unreadable case without `chmod` (which root ignores).
  test("config-unreadable (500) when the target exists but cannot be read", async () => {
    mkdirSync(join(config, "opencode.jsonc"))
    const response = await patch({ patch: { shadow: false } })
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe("config-unreadable")
  })

  test("invalid-config when the file is not valid JSONC", async () => {
    const path = join(config, "opencode.json")
    writeFileSync(path, '{ "flupcode": { "adaptive": ')
    const handler = open({ adaptiveConfig: surface(), token: TOKEN })
    const response = await call(handler, "/harness/adaptive/config", {
      method: "PATCH",
      body: { patch: { shadow: false } },
      token: TOKEN,
    })
    expect(response.status).toBe(422)
    expect((await response.json()).code).toBe("invalid-config")
  })

  // `chmod 0` does not stop root, so the unreadable case cannot be reproduced there.
  test.skipIf(process.getuid?.() === 0)("config-unreadable when the file cannot be read", async () => {
    const path = join(config, "opencode.json")
    writeFileSync(path, JSON.stringify({ flupcode: { adaptive: {} } }))
    chmodSync(path, 0o000)
    try {
      const handler = open({ adaptiveConfig: surface(), token: TOKEN })
      const response = await call(handler, "/harness/adaptive/config", {
        method: "PATCH",
        body: { patch: { shadow: false } },
        token: TOKEN,
      })
      expect(response.status).toBe(500)
      expect((await response.json()).code).toBe("config-unreadable")
    } finally {
      chmodSync(path, 0o644)
    }
  })

  test("a body without a patch object is refused", async () => {
    const response = await patch({ confirm: true })
    expect(response.status).toBe(422)
    expect((await response.json()).code).toBe("invalid-value")
  })
})

describe("the capability", () => {
  test("is announced when the surface is built and absent otherwise", async () => {
    const withSurface = open({ adaptiveConfig: surface() })
    const health = await (await withSurface(new Request("http://x/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-config")

    const without = open()
    const other = await (await without(new Request("http://x/harness/health"))).json()
    expect(other.capabilities).not.toContain("adaptive-config")
  })
})
