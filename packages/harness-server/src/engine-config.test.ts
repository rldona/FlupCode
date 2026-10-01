import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { engineConfigPath, patchEngineConfig, readEngineConfig } from "./engine-config"

let configDir: string
let project: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "engine-config-global-"))
  project = mkdtempSync(join(tmpdir(), "engine-config-project-"))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

test("a scope with no file reads empty and is written to a new opencode.json", async () => {
  expect(readEngineConfig({ scope: "global", configDir })).toEqual({
    path: join(configDir, "opencode.json"),
    config: {},
  })
  await patchEngineConfig({ scope: "global", configDir, patch: { compaction: { auto: false } } })
  expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"))).toEqual({ compaction: { auto: false } })
})

test("an existing opencode.jsonc is preferred, and a config.json, which 2.x never reads, is not", () => {
  writeFileSync(join(configDir, "config.json"), "{}")
  expect(engineConfigPath({ scope: "global", configDir })).toBe(join(configDir, "opencode.json"))
  writeFileSync(join(configDir, "opencode.jsonc"), "{}")
  expect(engineConfigPath({ scope: "global", configDir })).toBe(join(configDir, "opencode.jsonc"))
  expect(engineConfigPath({ scope: "project", directory: project })).toBe(join(project, "opencode.json"))
  expect(() => engineConfigPath({ scope: "project" })).toThrow("A folder is required")
})

test("a patch merges deeply and keeps the comments and every key it does not name", async () => {
  const path = join(configDir, "opencode.jsonc")
  writeFileSync(
    path,
    `{
  // the user's own note
  "model": "anthropic/claude",
  "permission": { "bash": "ask" },
  "flupcode": { "configRepo": "/repo" }
}
`,
  )
  const result = await patchEngineConfig({ scope: "global", configDir, patch: { permission: { edit: "allow" } } })
  expect(result).toEqual({ path, changed: true })
  const text = readFileSync(path, "utf8")
  expect(text).toContain("// the user's own note")
  expect(readEngineConfig({ scope: "global", configDir }).config).toEqual({
    model: "anthropic/claude",
    permission: { bash: "ask", edit: "allow" },
    flupcode: { configRepo: "/repo" },
  })
})

test("a provider entry is replaced whole, so a dropped model is gone", async () => {
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify({ provider: { local: { name: "Local", models: { a: {}, b: {} } }, other: { name: "Other" } } }),
  )
  await patchEngineConfig({
    scope: "global",
    configDir,
    patch: { provider: { local: { name: "Local", models: { a: {} } } } },
  })
  expect(readEngineConfig({ scope: "global", configDir }).config).toEqual({
    provider: { local: { name: "Local", models: { a: {} } }, other: { name: "Other" } },
  })
})

test("null removes a key, and an object replaces a key that held something else", async () => {
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ permission: "allow", mcp: { keep: { type: "local" }, drop: { type: "local" } } }),
  )
  await patchEngineConfig({
    scope: "project",
    directory: project,
    patch: { permission: { bash: "deny" }, mcp: { drop: null } },
  })
  expect(readEngineConfig({ scope: "project", directory: project }).config).toEqual({
    permission: { bash: "deny" },
    mcp: { keep: { type: "local" } },
  })
})

test("removing a key that is not there leaves the file alone", async () => {
  writeFileSync(join(configDir, "opencode.json"), `{ "share": "manual" }\n`)
  expect(await patchEngineConfig({ scope: "global", configDir, patch: { mcp: { gone: null } } })).toMatchObject({
    changed: false,
  })
})

test("a patch that changes nothing leaves the file alone", async () => {
  writeFileSync(join(configDir, "opencode.json"), `{ "share": "manual" }\n`)
  expect(await patchEngineConfig({ scope: "global", configDir, patch: { share: "manual" } })).toMatchObject({
    changed: false,
  })
  expect(readFileSync(join(configDir, "opencode.json"), "utf8")).toBe(`{ "share": "manual" }\n`)
})

test("a malformed file is refused, not rewritten", async () => {
  writeFileSync(join(configDir, "opencode.json"), `{ "share": `)
  expect(patchEngineConfig({ scope: "global", configDir, patch: { share: "manual" } })).rejects.toThrow(
    "not valid JSONC",
  )
  expect(readFileSync(join(configDir, "opencode.json"), "utf8")).toBe(`{ "share": `)
})
