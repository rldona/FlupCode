import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { REASONING_VARIANTS_PLUGIN, SYSTEM_PROMPT_PLUGIN, engineConfigDir, installEnginePlugins } from "./engine-plugins"

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-engine-plugins-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  delete process.env.OPENCODE_MODELS_PATH
  delete process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
})

describe("engineConfigDir", () => {
  test("follows OpenCode: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(engineConfigDir({ OPENCODE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom")
    expect(engineConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "opencode"))
    expect(engineConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"))
  })
})

describe("installEnginePlugins", () => {
  test("writes the plugins once, replaces older copies, and leaves up-to-date ones alone", async () => {
    const config = await temp()
    await mkdir(path.join(config, "plugins"))
    await writeFile(path.join(config, "plugins", "reasoning-variants.ts"), "old")

    const first = await installEnginePlugins(config)
    expect(first.changed).toBe(true)
    expect(first.paths).toHaveLength(2)
    expect(await readFile(path.join(config, "plugins", REASONING_VARIANTS_PLUGIN.file), "utf8")).toBe(
      REASONING_VARIANTS_PLUGIN.source,
    )
    expect(await readFile(path.join(config, "plugins", SYSTEM_PROMPT_PLUGIN.file), "utf8")).toBe(
      SYSTEM_PROMPT_PLUGIN.source,
    )
    expect(await Bun.file(path.join(config, "plugins", "reasoning-variants.ts")).exists()).toBe(false)

    expect((await installEnginePlugins(config)).changed).toBe(false)
  })

  test("the installed plugin records the system prompt of each request", async () => {
    const config = await temp()
    const prompts = await temp()
    process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = prompts
    const { paths } = await installEnginePlugins(config)
    const plugin = (await import(pathToFileURL(paths[1]!).href)).flupcodeSystemPrompt
    const hooks = await plugin()

    await hooks["experimental.chat.system.transform"](
      { sessionID: "ses_abc", model: { providerID: "deepseek", id: "flash" } },
      { system: ["You are opencode.\n\n# Instructions from: /w/AGENTS.md"] },
    )
    const [record] = await readdir(path.join(prompts, "ses_abc"))
    const captured = JSON.parse(await readFile(path.join(prompts, "ses_abc", record!), "utf8"))
    expect(captured.providerID).toBe("deepseek")
    expect(captured.modelID).toBe("flash")
    expect(captured.system[0]).toContain("Instructions from: /w/AGENTS.md")

    // The id names a folder, so anything else is refused rather than written out of the directory.
    await hooks["experimental.chat.system.transform"]({ sessionID: "../escape", model: {} }, { system: ["x"] })
    expect(await readdir(prompts)).toEqual(["ses_abc"])
  })

  test("keeps a session's newest recordings and no more", async () => {
    const config = await temp()
    const prompts = await temp()
    process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = prompts
    const { paths } = await installEnginePlugins(config)
    const plugin = (await import(pathToFileURL(paths[1]!).href)).flupcodeSystemPrompt
    const hook = (await plugin())["experimental.chat.system.transform"]

    for (let turn = 0; turn < 9; turn++) {
      await hook({ sessionID: "ses_abc", model: {} }, { system: [`turn ${turn}`] })
    }
    const kept = (await readdir(path.join(prompts, "ses_abc"))).sort()
    expect(kept).toHaveLength(6)
    const newest = JSON.parse(await readFile(path.join(prompts, "ses_abc", kept.at(-1)!), "utf8"))
    expect(newest.system).toEqual(["turn 8"])
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
    const { paths } = await installEnginePlugins(config)
    const plugin = (await import(pathToFileURL(paths[0]!).href)).default

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
