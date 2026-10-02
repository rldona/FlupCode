import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { mcpStdioCommand } from "@flupcode/engine-contract/mcp"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { EngineError } from "./error"
import { createV2Domains, type EngineConfigStore } from "./v2"

/**
 * The OpenCode 2 adapter's config against a real 2.x engine (V2-24): what the app saves goes into the
 * engine's files through the store, the engine reloads it, and what the app reads back carries the
 * keys 2.x itself leaves out. The store here is a plain file one; the harness server's writer, which
 * the app uses, is proven against the same engine in packages/harness-server. Runs on the v2 line
 * only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-config.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url, env: { OPENCODE_DISABLE_PROJECT_CONFIG: undefined } })
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
  domains = createV2Domains(engine.url, { configStore: fileStore(join(engine.home, ".config", "opencode")) })
})

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("config on the OpenCode 2 adapter", () => {
  test("a global setting is saved, and read back with the keys 2.x leaves out", async () => {
    await domains.updateGlobalConfig({ flupcode: { configRepo: "/repo" }, disabled_providers: ["openrouter"] })
    expect(await domains.globalConfig()).toMatchObject({ disabled_providers: ["openrouter"] })
    expect((await domains.config()).flupcode).toEqual({ configRepo: "/repo" })
  })

  test("a folder's setting lands in the engine's own folder and wins over the global one", async () => {
    await domains.updateGlobalConfig({ compaction: { auto: true, reserved: 1000 } })
    await domains.updateConfig({ compaction: { auto: false } })
    expect(JSON.parse(readFileSync(join(engine.project, "opencode.json"), "utf8"))).toEqual({
      compaction: { auto: false },
    })
    expect((await domains.config()).compaction).toEqual({ auto: false, reserved: 1000 })
  })

  // The advanced editor (TI-12) shows each file as it is written, not the two merged.
  test("each scope's file is read on its own, for the advanced editor", async () => {
    await domains.updateGlobalConfig({ small_model: "stub/global" })
    await domains.updateConfig({ instructions: ["FOLDER.md"] })
    expect(await domains.configFile("global")).toMatchObject({ small_model: "stub/global" })
    const folder = await domains.configFile("project")
    expect(folder).toMatchObject({ instructions: ["FOLDER.md"] })
    expect(folder).not.toHaveProperty("small_model")
  })

  test("an MCP server is saved, connects on reload, and is gone once removed", async () => {
    await domains.mcp.add({
      server: "saved",
      config: { type: "local", command: mcpStdioCommand() },
      scope: "project",
      directory: engine.project,
    })
    expect(Object.keys((await domains.mcp.config({ directory: engine.project })).data)).toContain("saved")
    await status("saved", (value) => value === "connected")

    await domains.mcp.remove({ server: "saved", directory: engine.project })
    expect(Object.keys((await domains.mcp.config({ directory: engine.project })).data)).not.toContain("saved")
    await status("saved", (value) => value === undefined)
  })

  test("without a store the config reads empty and saving says why", async () => {
    const bare = createV2Domains(engine.url)
    expect(await bare.config()).toEqual({})
    const refused = await bare.updateConfig({ share: "manual" }).catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(EngineError)
    expect((refused as EngineError).tag).toBe("UnsupportedByEngine")
  })
})

/** The engine's files, merged the way the harness server's writer merges them, minus its care. */
function fileStore(configDir: string): EngineConfigStore {
  const path = (scope: "global" | "project", directory?: string) =>
    join(scope === "global" ? configDir : directory!, "opencode.json")
  const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {})
  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> =>
    Object.entries(patch).reduce<Record<string, unknown>>((result, [key, value]) => {
      if (value === null) return Object.fromEntries(Object.entries(result).filter(([name]) => name !== key))
      const current = result[key]
      if (typeof value !== "object" || Array.isArray(value)) return { ...result, [key]: value }
      const base = typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
      return { ...result, [key]: merge(base, value as Record<string, unknown>) }
    }, base)
  return {
    read: async (scope, directory) => ({ path: path(scope, directory), config: read(path(scope, directory)) }),
    patch: async (scope, patch, directory) => {
      const file = path(scope, directory)
      writeFileSync(file, JSON.stringify(merge(read(file), patch), null, 2))
      return { path: file, changed: true }
    },
  }
}

async function status(name: string, match: (status: string | undefined) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const servers = (await domains.mcp.list({ directory: engine.project })).data
    const current = (servers.find((item) => item.name === name)?.status as { status?: string } | undefined)?.status
    if (match(current)) return
    if (Date.now() > deadline) throw new Error(`MCP server ${name} stayed ${current}`)
    await Bun.sleep(100)
  }
}
