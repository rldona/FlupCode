import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { enginePluginFolders, enginePluginsDir, installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { startModel } from "../src/model"

/**
 * Where FlupCode's plugins live (HE-04): in FlupCode's own folder, named in the config of the engines
 * FlupCode starts, so an `opencode` the reader starts themselves loads none of them, while the
 * reader's own global plugins and config keep loading in FlupCode's engine. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/plugin-location-v2.test.ts
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
const ours = enginePluginFolders({}, "/").map((folder) => basename(folder))
const userPlugin = `export default { id: "user-own", setup: async () => {} }\n`
let flupcode: Engine
let standalone: Engine

/** The reader's own global plugin and config, and the copies an earlier FlupCode left beside them. */
function readerSetup(home: string) {
  const plugins = join(home, ".config", "opencode", "plugins")
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, "user-own.js"), userPlugin)
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ username: "reader-global-config" }),
  )
  // As 3.0.x wrote them: each plugin's own file name and source, straight into the global folder.
  for (const id of ours)
    writeFileSync(
      join(plugins, `${id}.js`),
      `// Installed by FlupCode for OpenCode 2.\nexport default { id: "${id}", setup: async () => {} }\n`,
    )
}

beforeAll(async () => {
  if (!run) return
  flupcode = await startEngine({
    modelUrl: model.url,
    flupcodePlugins: true,
    prepare: async (home) => readerSetup(home),
  })
  // A machine FlupCode installed its plugins on, and an engine the reader starts by hand.
  standalone = await startEngine({
    modelUrl: model.url,
    env: { OPENCODE_PURE: undefined },
    prepare: async (home) => {
      readerSetup(home)
      await installEnginePlugins({ XDG_CONFIG_HOME: join(home, ".config") }, home)
    },
  })
}, 240_000)

afterAll(async () => {
  await flupcode?.stop()
  await standalone?.stop()
  model.stop()
})

describe.skipIf(!run)("FlupCode's plugins in FlupCode's own folder (HE-04)", () => {
  test("FlupCode's engine reports every plugin active, each from FlupCode's folder", async () => {
    const plugins = await settledPlugins(flupcode, (list) => list.filter(isOurs).length >= ours.length)
    const managed = enginePluginsDir({ XDG_CONFIG_HOME: join(flupcode.home, ".config") }, flupcode.home)
    const loaded = plugins.filter(isOurs)
    expect(Object.fromEntries(loaded.map((plugin) => [plugin.id, plugin.state?.status]))).toEqual(
      Object.fromEntries(ours.map((id) => [id, "active"])),
    )
    expect(loaded.map((plugin) => dirname(dirname(plugin.source!.path!)))).toEqual(loaded.map(() => managed))
  })

  test("the reader's own global plugin and config still load in FlupCode's engine", async () => {
    const plugins = await settledPlugins(flupcode, (list) => list.some((plugin) => plugin.id === "user-own"))
    expect(plugins.find((plugin) => plugin.id === "user-own")?.state?.status).toBe("active")
    const config = (await call(flupcode, "/api/config")) as Array<{ path?: string; info?: { username?: string } }>
    expect(
      config.find((entry) => entry.path?.endsWith(join(".config", "opencode", "opencode.json")))?.info?.username,
    ).toBe("reader-global-config")
  })

  test("the copies an earlier FlupCode wrote into the global plugins folder are gone, the reader's plugin stays", () => {
    expect(readdirSync(join(flupcode.home, ".config", "opencode", "plugins"))).toEqual(["user-own.js"])
    for (const id of ours)
      expect(existsSync(join(flupcode.home, ".config", "flupcode", "engine-plugins", id, "index.js"))).toBe(true)
  })

  test("an engine the reader starts loads none of FlupCode's plugins, and their own as before", async () => {
    const plugins = await settledPlugins(standalone, (list) => list.some((plugin) => plugin.id === "user-own"))
    expect(plugins.filter(isOurs).map((plugin) => plugin.source?.path)).toEqual([])
    expect(plugins.find((plugin) => plugin.id === "user-own")?.state?.status).toBe("active")
  })
})

type Plugin = { id?: string; source?: { type?: string; path?: string }; state?: { status?: string } }

function isOurs(plugin: Plugin) {
  return plugin.id !== undefined && ours.includes(plugin.id)
}

/** The engine loads a location's plugins after its first request, so the list is read until it settles. */
async function settledPlugins(engine: Engine, done: (list: Plugin[]) => boolean) {
  const deadline = Date.now() + 30_000
  let list: Plugin[] = []
  while (Date.now() < deadline) {
    list = ((await call(engine, "/api/plugin")) as { data: Plugin[] }).data
    if (done(list)) return list
    await Bun.sleep(250)
  }
  return list
}

async function call(engine: Engine, path: string) {
  const response = await fetch(`${engine.url}${path}`, {
    headers: { authorization: engine.authorization, "x-opencode-directory": encodeURIComponent(engine.project) },
  })
  expect(response.ok).toBe(true)
  return response.json() as Promise<unknown>
}
