import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { patchEngineConfig } from "./engine-config"

/**
 * The engine config writer against a real 2.x engine (V2-24): what it writes, in the 1.x shape, is
 * what OpenCode 2 loads once its location reloads, comments, unknown keys and all. Runs on the v2
 * line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine-config.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine

beforeAll(async () => {
  if (!run) return
  // Project files load here, unlike the rest of the contract suite.
  engine = await startEngine({ modelUrl: model.url, env: { OPENCODE_DISABLE_PROJECT_CONFIG: undefined } })
})

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the engine config writer on OpenCode 2", () => {
  test("a global write in 1.x shape is loaded once the location reloads", async () => {
    const configDir = join(engine.home, ".config", "opencode")
    writeFileSync(
      join(configDir, "opencode.jsonc"),
      `{
  // FlupCode's own block: 2.x does not know it and must still load the file
  "flupcode": { "configRepo": "/repo" }
}
`,
    )
    const written = await patchEngineConfig({
      scope: "global",
      configDir,
      patch: { compaction: { reserved: 4321 }, permission: { webfetch: "deny" } },
    })
    expect(written).toEqual({ path: join(configDir, "opencode.jsonc"), changed: true })
    await reload()

    const document = (await config()).find((entry) => entry.path === written.path)
    expect(document?.info).toMatchObject({
      compaction: { buffer: 4321 },
      permissions: expect.arrayContaining([{ action: "webfetch", resource: "*", effect: "deny" }]),
    })
  })

  test("a folder's write lands in its opencode.json, which 2.x reads", async () => {
    const written = await patchEngineConfig({
      scope: "project",
      directory: engine.project,
      patch: { permission: { edit: "ask" } },
    })
    expect(written.path).toBe(join(engine.project, "opencode.json"))
    await reload()

    const document = (await config()).find((entry) => entry.path === written.path)
    expect(document?.info).toMatchObject({
      permissions: expect.arrayContaining([{ action: "edit", resource: "*", effect: "ask" }]),
    })
  })
})

const request = (path: string, init?: RequestInit) =>
  fetch(`${engine.url}${path}`, {
    ...init,
    headers: { authorization: engine.authorization, "x-opencode-directory": encodeURIComponent(engine.project) },
  })

async function reload() {
  expect((await request("/api/location/reload", { method: "POST" })).ok).toBe(true)
}

async function config() {
  return (await (await request("/api/config")).json()) as Array<{ type: string; path?: string; info?: unknown }>
}
