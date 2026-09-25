import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  ARTIFACT_WRITE_PLUGIN,
  DELIVERY_PLUGIN,
  REASONING_VARIANTS_PLUGIN,
  SYSTEM_PROMPT_PLUGIN,
  TOOL_USES_PLUGIN,
  WEB_ACTIONS_PLUGIN,
  engineConfigDir,
  installEnginePlugins,
} from "./engine-plugins"

// The engine installs @opencode-ai/plugin into each config dir before loading plugins, so the
// delivery plugin can import it. A written copy is pointed at this repo's install to resolve it.
const nodeModules = path.resolve(import.meta.dir, "../../../node_modules")

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-engine-plugins-"))
  dirs.push(dir)
  return dir
}

const installed = async (config: string, file: string, exported: string) => {
  const { paths } = await installEnginePlugins(config)
  const target = paths.find((entry) => entry.endsWith(file))
  expect(target).toBeDefined()
  return (await import(pathToFileURL(target!).href))[exported]
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  delete process.env.OPENCODE_MODELS_PATH
  delete process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
  delete process.env.FLUPCODE_TOOL_USES_DIR
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.FLUPCODE_CONFIG_DIR
  delete process.env.FLUPCODE_HARNESS_SERVER_URL
  delete process.env.FLUPCODE_HARNESS_PORT
  delete process.env.FLUPCODE_BROWSER_DISABLED
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
    expect(first.paths).toHaveLength(6)
    for (const plugin of [
      REASONING_VARIANTS_PLUGIN,
      SYSTEM_PROMPT_PLUGIN,
      TOOL_USES_PLUGIN,
      ARTIFACT_WRITE_PLUGIN,
      DELIVERY_PLUGIN,
      WEB_ACTIONS_PLUGIN,
    ]) {
      expect(await readFile(path.join(config, "plugins", plugin.file), "utf8")).toBe(plugin.source)
    }
    expect(await Bun.file(path.join(config, "plugins", "reasoning-variants.ts")).exists()).toBe(false)

    expect((await installEnginePlugins(config)).changed).toBe(false)
  })

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

  test("the delivery plugin registers one tool per profile, guards the delivery and re-emits the image", async () => {
    const config = await temp()
    process.env.OPENCODE_CONFIG_DIR = config
    await mkdir(path.join(config, "plans"), { recursive: true })
    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({
        flupcode: {
          delivery: {
            sample: {
              tool: "deliver_sample",
              composeTools: ["compose_sample"],
              guards: ["plans/guard.mjs"],
              labels: { title: "Piece ready.", text: "Copy:", alt: "Alt:", image: "The image goes below.", missingAlt: "No alt to show." },
            },
            flagless: { tool: "deliver_flagless", imageRequired: false },
          },
        },
      }),
    )
    await writeFile(
      path.join(config, "plans", "guard.mjs"),
      `export const guards = [
        { id: "blocked", assess: ({ text }) => text.includes("bad") ? { allow: false, code: "NOPE", reason: "contains bad" } : { allow: true } },
      ]`,
    )
    await symlink(nodeModules, path.join(config, "node_modules"), "dir")

    const plugin = await installed(config, DELIVERY_PLUGIN.file, "flupcodeDeliver")
    const hooks = await plugin()
    expect(Object.keys(hooks.tool).sort()).toEqual(["deliver_flagless", "deliver_sample"])
    const execute = hooks.tool["deliver_sample"].execute

    const composed = [
      { parts: [{ type: "tool", tool: "compose_sample", state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,AAAA" }] } }] },
    ]
    const ctx = { messages: composed, sessionID: "ses_abc", messageID: "msg_1" }

    // A guard refuses in order, before anything else runs, and the profile's own labels are used.
    expect(await execute({ text: "bad text", template: "square" }, ctx)).toBe("No se entrega. NOPE: contains bad")

    const delivered = await execute({ text: "good text", template: "square", alt: "alt text" }, ctx)
    expect(delivered.output).toBe("Piece ready.\n\nCopy:\ngood text\n\nAlt:\nalt text\n\nThe image goes below.")
    expect(delivered.attachments).toEqual([
      {
        id: expect.stringMatching(/^prt_/),
        sessionID: "ses_abc",
        messageID: "msg_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAAA",
      },
    ])

    // With no alt, the profile phrases the absence in its own language; no profile falls back to English.
    const noAlt = await execute({ text: "good text", template: "square" }, ctx)
    expect(noAlt.output).toBe("Piece ready.\n\nCopy:\ngood text\n\nNo alt to show.\n\nThe image goes below.")

    // Only a producer named in composeTools counts as the composed input.
    const other = [
      { parts: [{ type: "tool", tool: "compose_other", state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,BBBB" }] } }] },
    ]
    expect(await execute({ text: "x", template: "square" }, { ...ctx, messages: other })).toContain("composed image")

    // imageRequired false delivers without an image rather than stopping.
    const flagless = hooks.tool["deliver_flagless"].execute
    expect(await flagless({ text: "no image here", template: "square" }, { messages: [], sessionID: "s", messageID: "m" })).toBe(
      "Ready to copy and paste. Nothing was published.\n\nText:\nno image here\n\nThe image has no alt.",
    )
  })

  test("the delivery plugin reads JSONC with trailing commas and slashes inside strings", async () => {
    const config = await temp()
    process.env.OPENCODE_CONFIG_DIR = config
    await writeFile(
      path.join(config, "opencode.json"),
      `{
  // A profile whose description carries a URL and a bare double slash that is not a comment.
  "flupcode": {
    "delivery": {
      "sample": {
        "tool": "deliver_sample",
        "imageRequired": false,
        "description": "see https://example.com/x and // not a comment",
      },
    },
  },
}`,
    )
    await symlink(nodeModules, path.join(config, "node_modules"), "dir")

    const plugin = await installed(config, DELIVERY_PLUGIN.file, "flupcodeDeliver")
    const hooks = await plugin()
    expect(Object.keys(hooks.tool)).toEqual(["deliver_sample"])
  })

  test("a profile in opencode.jsonc wins over opencode.json and both files are merged", async () => {
    const config = await temp()
    process.env.OPENCODE_CONFIG_DIR = config
    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({
        flupcode: {
          delivery: {
            sample: { tool: "deliver_from_json", imageRequired: false },
            shared: { tool: "deliver_shared_old", imageRequired: false },
          },
        },
      }),
    )
    await writeFile(
      path.join(config, "opencode.jsonc"),
      `{
  // jsonc wins on the same field.
  "flupcode": {
    "delivery": {
      "sample": { "tool": "deliver_from_jsonc", "imageRequired": false },
      "extra": { "tool": "deliver_extra", "imageRequired": false },
    },
  },
}`,
    )
    await symlink(nodeModules, path.join(config, "node_modules"), "dir")

    const plugin = await installed(config, DELIVERY_PLUGIN.file, "flupcodeDeliver")
    const hooks = await plugin()
    expect(Object.keys(hooks.tool).sort()).toEqual(["deliver_extra", "deliver_from_jsonc", "deliver_shared_old"])
  })

  test("guards fail closed: one that cannot load and one that throws both refuse the delivery", async () => {
    const config = await temp()
    process.env.OPENCODE_CONFIG_DIR = config
    await mkdir(path.join(config, "plans"), { recursive: true })
    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({
        flupcode: {
          delivery: {
            missing: { tool: "deliver_missing", imageRequired: false, guards: ["plans/nope.mjs"] },
            throwing: { tool: "deliver_throwing", imageRequired: false, guards: ["plans/throwing.mjs"] },
          },
        },
      }),
    )
    await writeFile(
      path.join(config, "plans", "throwing.mjs"),
      `export const guards = [{ id: "boom", assess: () => { throw new Error("kaboom") } }]`,
    )
    await symlink(nodeModules, path.join(config, "node_modules"), "dir")

    const plugin = await installed(config, DELIVERY_PLUGIN.file, "flupcodeDeliver")
    const hooks = await plugin()
    const call = (name: string) =>
      hooks.tool[name].execute(
        { text: "x", template: "square" },
        { messages: [], sessionID: "s", messageID: "m" },
      )
    expect(await call("deliver_missing")).toBe("No se entrega. GUARD_LOAD_ERROR: plans/nope.mjs")
    expect(await call("deliver_throwing")).toBe("No se entrega. GUARD_ERROR: boom - kaboom")
  })
})

describe("WEB_ACTIONS_PLUGIN", () => {
  const servers: Array<() => void> = []
  afterEach(() => {
    for (const stop of servers.splice(0)) stop()
  })

  // The profiles the harness would list. `do_demo` writes and uploads, so it is sensitive and needs
  // an image; `read_demo` only reads, so it runs under `browser` alone.
  const profiles = [
    {
      id: "do_demo",
      tool: "do_demo",
      description: "Publish the demo piece.",
      kind: "browser",
      origin: "https://example.test",
      inputs: { text: "string", image: "image" },
      steps: [
        { goto: "{{origin}}/compose" },
        { fill: { selector: "[data-editor]", text: "{{text}}" } },
        { upload: { selector: "input[type=file]", from: "{{image}}" } },
        { submit: { selector: "[data-publish]" } },
      ],
      guards: [],
      sensitive: true,
      availability: "host",
      evidence: { screenshots: "each" },
    },
    {
      id: "read_demo",
      tool: "read_demo",
      description: "Read the demo status.",
      kind: "browser",
      origin: "https://example.test",
      inputs: {},
      steps: [{ goto: "{{origin}}/status" }, { waitFor: "[data-status]" }],
      extract: { status: { selector: "[data-status]", as: "text" } },
      guards: [],
      sensitive: false,
      availability: "host",
      evidence: { screenshots: "each" },
    },
  ]

  const successResult = (body: Record<string, unknown>) => ({
    action: typeof body.action === "string" ? body.action : "do_demo",
    tool: "do_demo",
    status: "success",
    origin: "https://example.test",
    url: "https://example.test/done",
    title: "Done",
    startedAt: 1,
    finishedAt: 2,
    steps: [{ index: 0, kind: "goto", status: "ok", attempts: 1, durationMs: 1 }],
    evidence: ["art1"],
  })

  const startFixture = (
    options: {
      serveProfiles?: boolean
      run?: (body: Record<string, unknown>) => Response
      artifact?: (id: string) => Response | undefined
    } = {},
  ) => {
    const requests: Array<{ method: string; path: string; auth: string | null }> = []
    const runs: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        requests.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization") })
        if (url.pathname === "/harness/actions" && request.method === "GET") {
          if (options.serveProfiles === false) return new Response("Not found", { status: 404 })
          return Response.json({
            data: { profiles, rejected: [{ id: "broken", code: "unsupported_kind", message: "Only browser" }] },
          })
        }
        if (url.pathname === "/harness/actions/run" && request.method === "POST") {
          const parsed: unknown = await request.json().catch(() => ({}))
          const record: Record<string, unknown> =
            parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {}
          runs.push(record)
          return options.run ? options.run(record) : Response.json({ data: successResult(record) })
        }
        if (url.pathname.startsWith("/harness/artifacts/") && url.pathname.endsWith("/raw") && request.method === "GET") {
          const id = decodeURIComponent(url.pathname.slice("/harness/artifacts/".length, -"/raw".length))
          const custom = options.artifact ? options.artifact(id) : undefined
          if (custom) return custom
          if (id === "art1")
            return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
              headers: { "content-type": "image/png" },
            })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    const stop = () => {
      void server.stop(true)
    }
    servers.push(stop)
    return { url: server.url.origin, requests, runs }
  }

  const open = async (
    options: { fixture?: { url: string } | string; token?: string | false; composeTools?: string[] } = {},
  ) => {
    const config = await temp()
    const tokenDir = await temp()
    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({ flupcode: { composeTools: options.composeTools ?? ["compose_demo"] } }),
    )
    if (options.token !== false) await writeFile(path.join(tokenDir, "browser-token"), options.token ?? "token-abc")
    process.env.OPENCODE_CONFIG_DIR = config
    process.env.FLUPCODE_CONFIG_DIR = tokenDir
    if (options.fixture) {
      process.env.FLUPCODE_HARNESS_SERVER_URL =
        typeof options.fixture === "string" ? options.fixture : options.fixture.url
    }
    await symlink(nodeModules, path.join(config, "node_modules"), "dir")
    const plugin = await installed(config, WEB_ACTIONS_PLUGIN.file, "flupcodeActions")
    const hooks = await plugin()
    return { plugin, hooks }
  }

  const composedMessages = () => [
    {
      parts: [
        {
          type: "tool",
          tool: "compose_demo",
          state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,AAAA" }] },
        },
      ],
    },
  ]

  test("registers one tool per profile with only the string inputs as args", async () => {
    const fixture = startFixture()
    const { plugin, hooks } = await open({ fixture })

    expect(typeof plugin).toBe("function")
    expect(plugin.name).toBe("flupcodeActions")
    expect(Object.keys(hooks.tool).sort()).toEqual(["do_demo", "read_demo"])
    expect(hooks.tool.do_demo.description).toBe("Publish the demo piece.")
    // The image input is not an argument: it comes from the composed piece, not the model.
    expect(hooks.tool.do_demo.args).toEqual({ text: { type: "string", description: 'Value for the "text" input.' } })
    expect(hooks.tool.read_demo.args).toEqual({})

    const listed = fixture.requests.filter((entry) => entry.method === "GET" && entry.path === "/harness/actions")
    expect(listed).toHaveLength(1)
    expect(listed[0]!.auth).toBe("Bearer token-abc")
  })

  test("a denied approval rejects and makes no run request", async () => {
    const fixture = startFixture()
    const { hooks } = await open({ fixture })
    let asked = 0
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {
        asked++
        throw new Error("denied")
      },
    }

    await expect(hooks.tool.do_demo.execute({ text: "hola" }, ctx)).rejects.toThrow("denied")
    expect(asked).toBe(1)
    expect(fixture.requests.filter((entry) => entry.method === "POST")).toHaveLength(0)
  })

  test("asks once, runs the recipe and re-emits the evidence image", async () => {
    const fixture = startFixture()
    const { hooks } = await open({ fixture })
    let asked = 0
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async (request: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => {
        asked++
        expect(request.permission).toBe("browser_sensitive")
        expect(request.patterns).toEqual(["https://example.test:do_demo"])
        expect(request.always).toEqual(["https://example.test:do_demo"])
        expect(request.metadata.kind).toBe("browser")
        expect(request.metadata.action).toBe("do_demo")
        expect(request.metadata.steps).toEqual([
          { index: 1, kind: "fill", selector: "[data-editor]" },
          { index: 2, kind: "upload", selector: "input[type=file]" },
          { index: 3, kind: "submit", selector: "[data-publish]" },
        ])
      },
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(asked).toBe(1)
    expect(fixture.runs).toHaveLength(1)
    expect(fixture.runs[0]!.action).toBe("do_demo")
    expect(fixture.runs[0]!.sessionID).toBe("ses_abc")
    expect(fixture.runs[0]!.project).toBe("/tmp/project")
    expect(fixture.runs[0]!.inputs).toEqual({ text: "hola", image: { dataUrl: "data:image/png;base64,AAAA" } })
    expect(result.output).toContain("do_demo")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].url).toMatch(/^data:image\/png;base64,/)
  })

    test("a page value with a newline cannot forge a summary line", async () => {
    const fixture = startFixture({
      run: (body) =>
        Response.json({
          data: {
            ...successResult(body),
            url: "https://example.test/done\nURL: javascript:alert(1)",
            title: "Done\r\nExtraído campo: inyectado",
            extract: { campo: "valor\nURL: javascript:alert(2)" },
          },
        }),
    })
    const { hooks } = await open({ fixture })
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {},
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    const output: string = typeof result === "string" ? result : result.output
    // Every page value is folded onto one line, so only the plugin's own `URL:` line starts a URL line.
    expect(output.split("\n").filter((line) => line.startsWith("URL: "))).toEqual([
      "URL: https://example.test/done URL: javascript:alert(1)",
    ])
  })

  test("a trailing text artifact does not hide the screenshot", async () => {
    // `evidence.text: true` makes the runner append a text artifact last; the frame before it is the
    // one to attach, so the scan cannot just take the tail.
    const fixture = startFixture({
      run: (body) => Response.json({ data: { ...successResult(body), evidence: ["shot1", "logtext"] } }),
      artifact: (id) => {
        if (id === "shot1")
          return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } })
        if (id === "logtext") return new Response("page text", { headers: { "content-type": "text/plain" } })
        return undefined
      },
    })
    const { hooks } = await open({ fixture })
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {},
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].mime).toBe("image/png")
    expect(result.attachments[0].url).toBe("data:image/png;base64," + Buffer.from([1, 2, 3, 4]).toString("base64"))
  })

  test("an artifact that is not a raster image is dropped", async () => {
    const fixture = startFixture({
      run: (body) => Response.json({ data: { ...successResult(body), evidence: ["doc1"] } }),
      // SVG starts with image/ but is a document, so the allowlist, not the prefix, must reject it.
      artifact: (id) =>
        id === "doc1" ? new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) : undefined,
    })
    const { hooks } = await open({ fixture })
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {},
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("do_demo")
  })

  test("an artifact past the byte cap is dropped", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    const fixture = startFixture({
      run: (body) => Response.json({ data: { ...successResult(body), evidence: ["big1"] } }),
      artifact: (id) => (id === "big1" ? new Response(big, { headers: { "content-type": "image/png" } }) : undefined),
    })
    const { hooks } = await open({ fixture })
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {},
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("do_demo")
  })

  test("the composed image comes only from a declared compose tool", async () => {
    const fixture = startFixture()
    const { hooks } = await open({ fixture })
    // A non-listed producer sits both older and newer than the declared one: the newest image must
    // still be the declared tool's, or dropping the filter would let the other win.
    const messages = [
      {
        parts: [
          { type: "tool", tool: "compose_other", state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,CCCC" }] } },
        ],
      },
      {
        parts: [
          { type: "tool", tool: "compose_demo", state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,AAAA" }] } },
        ],
      },
      {
        parts: [
          { type: "tool", tool: "compose_other", state: { attachments: [{ mime: "image/png", url: "data:image/png;base64,BBBB" }] } },
        ],
      },
    ]
    const ctx = { messages, sessionID: "ses_abc", messageID: "msg_1", directory: "/tmp/project", ask: async () => {} }

    await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(fixture.runs).toHaveLength(1)
    expect(fixture.runs[0]!.inputs).toEqual({
      text: "hola",
      image: { dataUrl: "data:image/png;base64,AAAA" },
    })
  })

  test("a read profile asks for the browser permission on its origin", async () => {
    const fixture = startFixture()
    const { hooks } = await open({ fixture })
    let asked = 0
    const ctx = {
      messages: [],
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async (request: { permission: string; patterns: string[]; always: string[] }) => {
        asked++
        expect(request.permission).toBe("browser")
        expect(request.patterns).toEqual(["https://example.test"])
        expect(request.always).toEqual(["https://example.test"])
      },
    }

    const result = await hooks.tool.read_demo.execute({}, ctx)
    expect(asked).toBe(1)
    expect(result.output).toContain("read_demo")
  })

  test("a recipe that uploads with no composed image stops before approval or HTTP", async () => {
    const fixture = startFixture()
    const { hooks } = await open({ fixture })
    let asked = 0
    const ctx = {
      messages: [],
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {
        asked++
      },
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("imagen compuesta")
    expect(asked).toBe(0)
    expect(fixture.requests.filter((entry) => entry.method === "POST")).toHaveLength(0)
  })

  test("the kill switch registers nothing and makes no request at all", async () => {
    const fixture = startFixture()
    process.env.FLUPCODE_BROWSER_DISABLED = "1"
    const { hooks } = await open({ fixture })
    expect(hooks).toEqual({})
    expect(fixture.requests).toHaveLength(0)
  })

  test("no endpoint, no server or no token all register nothing without throwing", async () => {
    const notFound = startFixture({ serveProfiles: false })
    expect((await open({ fixture: notFound })).hooks).toEqual({})
    expect(notFound.requests.filter((entry) => entry.method === "GET")).toHaveLength(1)

    expect((await open({ fixture: "http://127.0.0.1:1" })).hooks).toEqual({})

    const fixture = startFixture()
    expect((await open({ fixture, token: false })).hooks).toEqual({})
    expect(fixture.requests).toHaveLength(0)
  })

  test("a non-loopback harness URL is refused before any token is sent", async () => {
    // The fixture stays up as a control: if the plugin resolved the remote host at all it would show
    // up as a request, and the bearer token would have left the machine.
    const fixture = startFixture()
    process.env.FLUPCODE_HARNESS_SERVER_URL = "https://evil.example"
    const { hooks } = await open({})
    expect(hooks).toEqual({})
    expect(fixture.requests).toHaveLength(0)
  })

  test("a structured runner error becomes a Spanish sentence", async () => {
    const fixture = startFixture({
      run: () =>
        Response.json({ error: "denied by guard", code: "guard_denied", guardCode: "NOPE", evidence: [] }, { status: 422 }),
    })
    const { hooks } = await open({ fixture })
    const ctx = {
      messages: composedMessages(),
      sessionID: "ses_abc",
      messageID: "msg_1",
      directory: "/tmp/project",
      ask: async () => {},
    }

    const result = await hooks.tool.do_demo.execute({ text: "hola" }, ctx)
    expect(result).toContain("denegada")
    expect(result).toContain("NOPE")
    expect(fixture.runs).toHaveLength(1)
  })
})
