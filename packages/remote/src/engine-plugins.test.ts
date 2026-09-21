import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  ARTIFACT_WRITE_PLUGIN,
  REASONING_VARIANTS_PLUGIN,
  SYSTEM_PROMPT_PLUGIN,
  TOOL_USES_PLUGIN,
  engineConfigDir,
  installEnginePlugins,
} from "./engine-plugins"

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
  delete process.env.FLUPCODE_TOOL_USES_DIR
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
    expect(first.paths).toHaveLength(4)
    for (const plugin of [REASONING_VARIANTS_PLUGIN, SYSTEM_PROMPT_PLUGIN, TOOL_USES_PLUGIN, ARTIFACT_WRITE_PLUGIN]) {
      expect(await readFile(path.join(config, "plugins", plugin.file), "utf8")).toBe(plugin.source)
    }
    expect(await Bun.file(path.join(config, "plugins", "reasoning-variants.ts")).exists()).toBe(false)

    expect((await installEnginePlugins(config)).changed).toBe(false)
  })

  const installed = async (config: string, file: string, exported: string) => {
    const { paths } = await installEnginePlugins(config)
    const target = paths.find((entry) => entry.endsWith(file))
    expect(target).toBeDefined()
    return (await import(pathToFileURL(target!).href))[exported]
  }

  test("the installed plugin records the system prompt of each request", async () => {
    const config = await temp()
    const prompts = await temp()
    process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = prompts
    const plugin = await installed(config, SYSTEM_PROMPT_PLUGIN.file, "flupcodeSystemPrompt")
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

  test("keeps a session's newest recordings, in the order they were made", async () => {
    const config = await temp()
    const prompts = await temp()
    process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = prompts
    const plugin = await installed(config, SYSTEM_PROMPT_PLUGIN.file, "flupcodeSystemPrompt")
    const hook = (await plugin())["experimental.chat.system.transform"]

    // Nine requests with nothing between them: on a fast machine they share a millisecond, so the
    // name cannot be the time alone and the prune has to keep the last six, not any six.
    for (let turn = 0; turn < 9; turn++) {
      await hook({ sessionID: "ses_abc", model: {} }, { system: [`turn ${turn}`] })
    }
    const kept = (await readdir(path.join(prompts, "ses_abc"))).sort()
    expect(kept).toHaveLength(6)
    const turns = await Promise.all(
      kept.map(async (file) =>
        JSON.parse(await readFile(path.join(prompts, "ses_abc", file), "utf8")).system[0],
      ),
    )
    expect(turns).toEqual(["turn 3", "turn 4", "turn 5", "turn 6", "turn 7", "turn 8"])
  })

  test("the installed plugin counts what each session ran, and nothing twice", async () => {
    const config = await temp()
    const uses = await temp()
    process.env.FLUPCODE_TOOL_USES_DIR = uses
    const plugin = await installed(config, TOOL_USES_PLUGIN.file, "flupcodeToolUses")
    const hook = (await plugin())["tool.execute.before"]

    // A step can run several tools at once, and an MCP tool is named after its server.
    await Promise.all([
      hook({ tool: "bash", sessionID: "ses_abc" }),
      hook({ tool: "docs_search", sessionID: "ses_abc" }),
      hook({ tool: "docs_search", sessionID: "ses_abc" }),
    ])
    const written = JSON.parse(await readFile(path.join(uses, "ses_abc.json"), "utf8"))
    expect(written.tools.bash.count).toBe(1)
    expect(written.tools.docs_search.count).toBe(2)
    expect(written.tools.docs_search.last).toBeGreaterThan(0)

    // The id names a file, so anything else is refused rather than written outside the folder.
    await hook({ tool: "bash", sessionID: "../../escape" })
    expect(await readdir(uses)).toEqual(["ses_abc.json"])
  })

  test("the installed plugin times each call it sees finish", async () => {
    const config = await temp()
    const uses = await temp()
    process.env.FLUPCODE_TOOL_USES_DIR = uses
    const plugin = await installed(config, TOOL_USES_PLUGIN.file, "flupcodeToolUses")
    const hooks = await plugin()

    // The engine pairs a call's before and after by its callID. The after carries the duration.
    await hooks["tool.execute.before"]({ tool: "docs_search", sessionID: "ses_abc", callID: "call_1" })
    await hooks["tool.execute.after"]({ tool: "docs_search", sessionID: "ses_abc", callID: "call_1" })

    const written = JSON.parse(await readFile(path.join(uses, "ses_abc.json"), "utf8"))
    expect(written.calls).toHaveLength(1)
    expect(written.calls[0].tool).toBe("docs_search")
    expect(written.calls[0].ms).toBeGreaterThanOrEqual(0)

    // An after with no matching before is not timed rather than claimed to be instantaneous.
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_abc", callID: "never_started" })
    const after = JSON.parse(await readFile(path.join(uses, "ses_abc.json"), "utf8"))
    expect(after.calls).toHaveLength(1)
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

  test("the artifact tool writes a document where the Artifacts screen indexes it", async () => {
    const config = await temp()
    const project = await temp()
    const plugin = await installed(config, ARTIFACT_WRITE_PLUGIN.file, "flupcodeArtifactWrite")
    const hooks = await plugin()
    const tool = hooks.tool["artifact_write"]

    // Providers with an OpenAI-shaped API reject any function name outside this pattern, so a tool
    // named with a dot fails every request that carries it, not just the ones that call it.
    for (const name of Object.keys(hooks.tool)) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)

    await tool.execute(
      { title: "Report", filename: "../../escape.html", content: "<h1>hi</h1>" },
      { directory: project },
    )
    // The name is reduced to a file in the project's folder, not a path that climbs out of it.
    const written = await readFile(path.join(project, ".flupcode", "artifacts", "escape.html"), "utf8")
    expect(written).toBe("<h1>hi</h1>")
  })
})
