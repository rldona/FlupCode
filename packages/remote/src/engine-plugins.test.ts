import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { REASONING_VARIANTS_PLUGIN, engineConfigDir, installEnginePlugins } from "./engine-plugins"

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-engine-plugins-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  delete process.env.OPENCODE_MODELS_PATH
})

describe("engineConfigDir", () => {
  test("follows OpenCode: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(engineConfigDir({ OPENCODE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom")
    expect(engineConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "opencode"))
    expect(engineConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"))
  })
})

describe("installEnginePlugins", () => {
  test("writes the plugin once, replaces older copies, and leaves an up-to-date one alone", async () => {
    const config = await temp()
    await mkdir(path.join(config, "plugins"))
    await writeFile(path.join(config, "plugins", "reasoning-variants.ts"), "old")

    const first = await installEnginePlugins(config)
    expect(first.changed).toBe(true)
    expect(await readFile(first.path, "utf8")).toBe(REASONING_VARIANTS_PLUGIN.source)
    expect(await Bun.file(path.join(config, "plugins", "reasoning-variants.ts")).exists()).toBe(false)

    expect((await installEnginePlugins(config)).changed).toBe(false)
  })

  test("the installed plugin adds effort levels from the models.dev cache", async () => {
    const config = await temp()
    const models = path.join(config, "models.json")
    await writeFile(
      models,
      JSON.stringify({
        deepseek: { models: { flash: { reasoning_options: [{ type: "effort", values: ["low", "high", null] }] } } },
        openai: { models: { gpt: { reasoning_options: [{ type: "effort", values: ["none", "high"] }] } } },
      }),
    )
    process.env.OPENCODE_MODELS_PATH = models
    const { path: file } = await installEnginePlugins(config)
    const plugin = (await import(pathToFileURL(file).href)).default

    const flash = {
      id: "flash",
      api: { type: "native" },
      variants: [{ id: "high", headers: {}, body: { kept: true } }] as unknown[],
    }
    const gpt = { id: "gpt", api: { type: "aisdk", package: "@ai-sdk/openai" }, variants: [] as unknown[] }
    const records = [
      { provider: { id: "deepseek", api: { type: "aisdk", package: "@ai-sdk/openai-compatible" } }, models: new Map([["flash", flash]]) },
      { provider: { id: "openai", api: { type: "native" } }, models: new Map([["gpt", gpt]]) },
    ]
    await plugin.setup({
      catalog: { transform: async (fn: (catalog: unknown) => Promise<void>) => fn({ provider: { list: () => records } }) },
    })

    expect(plugin.id).toBe("flupcode-reasoning-variants")
    // An explicit level is kept; missing ones are added in the provider's body format.
    expect(flash.variants).toEqual([
      { id: "high", headers: {}, body: { kept: true } },
      { id: "low", headers: {}, body: { reasoning_effort: "low" } },
    ])
    expect(gpt.variants).toEqual([
      { id: "none", headers: {}, body: { reasoning: { effort: "none" } } },
      { id: "high", headers: {}, body: { reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] } },
    ])
  })

  test("never throws when the folder cannot be written", async () => {
    const config = await temp()
    await writeFile(path.join(config, "plugins"), "a file where the folder should be")
    const result = await installEnginePlugins(config)
    expect(result.changed).toBe(false)
    expect(result.error).toBeDefined()
  })
})
