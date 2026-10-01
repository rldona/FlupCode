import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { installEnginePlugins } from "./engine-plugins"

/**
 * The OpenCode 2 plugins (V2-30), each loaded from the file the installer writes and set up against
 * the slice of the plugin context it uses. The payloads are the ones a real 2.x engine hands the hooks
 * (`packages/engine-contract/test/plugins-v2.test.ts` proves them against one).
 */

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-engine-plugins-v2-"))
  dirs.push(dir)
  return dir
}

const realDataHome = process.env.XDG_DATA_HOME
beforeEach(async () => {
  process.env.XDG_DATA_HOME = await temp()
})

afterEach(async () => {
  if (realDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = realDataHome
  delete process.env.OPENCODE_MODELS_PATH
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Callback = (input: never) => unknown

/** The part of the 2.x plugin context these plugins touch, recording what they register. */
function context(directory = "/work/demo", events: unknown[] = []) {
  const hooks = new Map<string, Callback>()
  const transforms: Record<string, Callback> = {}
  return {
    hooks,
    transforms,
    ctx: {
      location: { directory },
      tool: {
        hook: async (name: string, callback: Callback) => void hooks.set(`tool.${name}`, callback),
        transform: async (callback: Callback) => void (transforms.tool = callback),
      },
      session: { hook: async (name: string, callback: Callback) => void hooks.set(`session.${name}`, callback) },
      model: { transform: async (callback: Callback) => void (transforms.model = callback) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            yield* events
          },
        }),
      },
    },
  }
}

async function plugin(file: string) {
  const config = await temp()
  const { paths } = await installEnginePlugins(config, "v2")
  const target = paths.find((entry) => entry.endsWith(file))
  expect(target).toBeDefined()
  return (await import(pathToFileURL(target!).href)).default as {
    id: string
    setup: (ctx: unknown) => Promise<unknown>
  }
}

const settle = () => Bun.sleep(50)
const data = (...parts: string[]) => path.join(process.env.XDG_DATA_HOME!, "flupcode", ...parts)
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"))

describe("installEnginePlugins for OpenCode 2", () => {
  test("writes the 2.x set, and removes the 1.x plugins that have no 2.x version yet", async () => {
    const config = await temp()
    await installEnginePlugins(config, "v1")
    const v1 = (await readdir(path.join(config, "plugins"))).sort()
    expect(v1).toContain("flupcode-cache-selection.js")

    const { paths, changed } = await installEnginePlugins(config, "v2")
    expect(changed).toBe(true)
    const v2 = (await readdir(path.join(config, "plugins"))).sort()
    expect(v2).toEqual(paths.map((file) => path.basename(file)).sort())
    expect(v2).not.toContain("flupcode-cache-selection.js")
    for (const file of v2)
      expect(await readFile(path.join(config, "plugins", file), "utf8")).toContain("export default {")

    // Nothing to do the second time; and back on 1.x every 1.x plugin returns.
    expect((await installEnginePlugins(config, "v2")).changed).toBe(false)
    await installEnginePlugins(config, "v1")
    expect((await readdir(path.join(config, "plugins"))).sort()).toEqual(v1)
  })
})

describe("OpenCode 2 plugins", () => {
  test("tool-uses times a call and keeps a shell's evidence, under the 1.x tool names", async () => {
    const tools = await plugin("flupcode-tool-uses.js")
    const recorded = context()
    await tools.setup(recorded.ctx)
    const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", input: { command: "exit 3" } }
    recorded.hooks.get("tool.execute.before")!({ ...call, tool: "shell" } as never)
    await settle()
    recorded.hooks.get("tool.execute.after")!({
      ...call,
      tool: "shell",
      status: "completed",
      result: { output: { exit: 3, truncated: false, output: "boom\n" }, content: [{ type: "text", text: "boom\n" }] },
    } as never)
    recorded.hooks.get("tool.execute.after")!({
      ...call,
      id: "call_2",
      tool: "edit",
      input: { path: "/work/demo/a.ts" },
      status: "error",
      error: { message: "no match" },
    } as never)
    await settle()

    const uses = await json(data("tool-uses", "ses_1.json"))
    expect(uses.tools.bash.count).toBe(1)
    expect(uses.calls).toEqual([expect.objectContaining({ tool: "bash" })])
    const signals = await json(data("episode-signals", "ses_1.json"))
    expect(signals.calls).toEqual([
      expect.objectContaining({ tool: "bash", ok: true, command: "exit 3", exit: 3, out: "boom\n" }),
      expect.objectContaining({ tool: "edit", ok: false, paths: ["/work/demo/a.ts"] }),
    ])
  })

  test("system-prompt records each request's system prompt as text", async () => {
    const prompt = await plugin("flupcode-system-prompt.js")
    const recorded = context()
    await prompt.setup(recorded.ctx)
    recorded.hooks.get("session.context")!({
      sessionID: "ses_1",
      model: { providerID: "stub", id: "stub-model" },
      system: [{ type: "text", text: "You are an agent." }],
    } as never)
    await settle()
    const [file] = await readdir(data("system-prompts", "ses_1"))
    expect(await json(data("system-prompts", "ses_1", file!))).toMatchObject({
      providerID: "stub",
      modelID: "stub-model",
      system: ["You are an agent."],
    })
  })

  test("artifact-write adds a tool, called by name, that keeps a document in the project", async () => {
    const project = await temp()
    const artifact = await plugin("flupcode-artifact-write.js")
    const recorded = context(project)
    await artifact.setup(recorded.ctx)
    const added: Array<{ name: string; options: unknown; execute: (input: unknown) => Promise<unknown> }> = []
    recorded.transforms.tool!({ add: (tool: (typeof added)[number]) => added.push(tool) } as never)
    expect(added.map((tool) => [tool.name, tool.options])).toEqual([["artifact_write", { codemode: false }]])
    expect(await added[0]!.execute({ title: "Report", filename: "../report.html", content: "<p>hi</p>" })).toEqual({
      content: expect.stringContaining("Kept report.html"),
    })
    expect(await readFile(path.join(project, ".flupcode", "artifacts", "report.html"), "utf8")).toBe("<p>hi</p>")
  })

  test("episode-events records a failed tool by its name and a failed run, not an interruption", async () => {
    const events = await plugin("flupcode-episode-events.js")
    const recorded = context("/work/demo", [
      { type: "session.tool.called", data: { sessionID: "ses_1", id: "call_1", name: "shell" } },
      {
        type: "session.tool.failed",
        data: { sessionID: "ses_1", id: "call_1", error: { type: "tool.execution", message: "boom" } },
      },
      { type: "session.tool.called", data: { sessionID: "ses_1", id: "call_2", name: "read" } },
      {
        type: "session.tool.failed",
        data: { sessionID: "ses_1", id: "call_2", error: { type: "aborted", message: "stopped" } },
      },
      { type: "session.execution.failed", data: { sessionID: "ses_1", error: { type: "provider", message: "500" } } },
      // Another location's session is that location's plugin to record.
      {
        type: "session.execution.failed",
        location: { directory: "/elsewhere" },
        data: { sessionID: "ses_2", error: { type: "provider", message: "500" } },
      },
    ])
    await events.setup(recorded.ctx)
    await settle()
    const ring = await json(data("events", "ses_1.json"))
    expect(ring.events).toEqual([
      expect.objectContaining({ kind: "tool.error", tool: "bash", callID: "call_1", message: "boom" }),
      expect.objectContaining({ kind: "session.error", error: "provider", message: "500" }),
    ])
    expect(existsSync(data("events", "ses_2.json"))).toBe(false)
  })

  test("reasoning-variants fills a model with no levels from models.dev, and leaves listed ones alone", async () => {
    const cache = path.join(await temp(), "models.json")
    await writeFile(
      cache,
      JSON.stringify({
        stub: { models: { bare: { reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
      }),
    )
    process.env.OPENCODE_MODELS_PATH = cache
    const variants = await plugin("flupcode-reasoning-variants.js")
    const recorded = context()
    await variants.setup(recorded.ctx)
    const models = [
      { providerID: "stub", id: "bare", variants: [] as unknown[] },
      { providerID: "stub", id: "listed", variants: [{ id: "max", settings: {} }] },
    ]
    recorded.transforms.model!({
      list: () => models,
      update: (providerID: string, id: string, edit: (model: (typeof models)[number]) => void) =>
        edit(models.find((model) => model.providerID === providerID && model.id === id)!),
    } as never)
    expect(models[0]!.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ])
    expect(models[1]!.variants).toEqual([{ id: "max", settings: {} }])
  })
})

/** A loopback harness that records every call and answers each route as the test says. */
async function harness(answers: Record<string, unknown> = {}) {
  const calls: Array<{ route: string; authorization: string | null; body: Record<string, unknown> }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const route = new URL(request.url).pathname
      calls.push({ route, authorization: request.headers.get("authorization"), body: await request.json() })
      return Response.json({ data: answers[route] ?? {} })
    },
  })
  const config = await temp()
  await writeFile(path.join(config, "adaptive-token"), "adaptive-token\n")
  process.env.FLUPCODE_CONFIG_DIR = config
  process.env.FLUPCODE_HARNESS_SERVER_URL = `http://127.0.0.1:${server.port}`
  stops.push(() => server.stop(true))
  return { calls, on: (route: string) => calls.filter((call) => call.route === route) }
}

const stops: Array<() => void> = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  delete process.env.FLUPCODE_CONFIG_DIR
  delete process.env.FLUPCODE_HARNESS_SERVER_URL
  delete process.env.FLUPCODE_RUNTIME_PROBE_FILE
})

describe("OpenCode 2 adaptive plugins", () => {
  test("runtime-probe stamps its boot and proves the hooks fire once a request is made", async () => {
    process.env.FLUPCODE_RUNTIME_PROBE_FILE = path.join(await temp(), "runtime-probe.json")
    const probe = await plugin("flupcode-runtime-probe.js")
    const recorded = context()
    await probe.setup(recorded.ctx)
    const stamped = await json(process.env.FLUPCODE_RUNTIME_PROBE_FILE)
    expect(stamped).toMatchObject({ pid: process.pid, hookAt: 0 })
    recorded.hooks.get("session.context")!({} as never)
    await settle()
    expect(await json(process.env.FLUPCODE_RUNTIME_PROBE_FILE)).toMatchObject({
      token: stamped.token,
      loadedAt: stamped.loadedAt,
      hook: "session.context",
      hookAt: expect.any(Number),
    })
  })

  test("guardrails sends a call's digest and a tool error's, with the adaptive token, under 1.x names", async () => {
    const harnessCalls = await harness()
    const guard = await plugin("flupcode-guardrails.js")
    const recorded = context("/work/demo")
    await guard.setup(recorded.ctx)
    const call = {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      tool: "shell",
      input: { command: "ls" },
    }
    recorded.hooks.get("tool.execute.before")!(call as never)
    recorded.hooks.get("tool.execute.after")!({ ...call, status: "error", error: { message: "denied" } } as never)
    recorded.hooks.get("tool.execute.after")!({
      ...call,
      id: "call_2",
      status: "error",
      error: { message: "Aborted" },
    } as never)
    await settle()
    const sent = harnessCalls.on("/harness/adaptive/guardrails")
    expect(sent.map((hit) => hit.authorization)).toEqual(["Bearer adaptive-token", "Bearer adaptive-token"])
    expect(sent.map((hit) => hit.body)).toEqual([
      {
        projectID: "/work/demo",
        sessionID: "ses_1",
        observation: {
          kind: "call",
          tool: "bash",
          argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          callID: "call_1",
        },
      },
      {
        projectID: "/work/demo",
        sessionID: "ses_1",
        observation: {
          kind: "error",
          tool: "bash",
          errorDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          callID: "call_1",
        },
      },
    ])
  })

  test("session-metrics turns a turn's events into a step, a tool and a compaction for its user message", async () => {
    const harnessCalls = await harness()
    const metrics = await plugin("flupcode-session-metrics.js")
    const at = (type: string, data: Record<string, unknown>) => ({
      type,
      location: { directory: "/work/demo" },
      data: { sessionID: "ses_1", ...data },
    })
    const recorded = context("/work/demo", [
      at("session.inbox.enqueued", { inboxID: "msg_u", item: { type: "user" } }),
      at("session.inbox.delivered", { inboxID: "msg_u" }),
      at("session.step.started", {
        assistantMessageID: "msg_a",
        agent: "build",
        model: { providerID: "stub", id: "m" },
      }),
      at("session.tool.input.started", { assistantMessageID: "msg_a", id: "call_1", name: "shell" }),
      at("session.tool.called", { assistantMessageID: "msg_a", id: "call_1", input: { command: "ls" } }),
      at("session.tool.success", {
        assistantMessageID: "msg_a",
        id: "call_1",
        content: [{ type: "text", text: "abc" }],
      }),
      at("session.step.ended", {
        assistantMessageID: "msg_a",
        cost: 0.5,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } },
      }),
      at("session.compaction.ended", { inputID: "msg_c" }),
    ])
    await metrics.setup(recorded.ctx)
    await settle()
    expect(harnessCalls.on("/harness/adaptive/metrics").map((hit) => hit.body.observation)).toEqual([
      { kind: "tool", id: "call_1", turnID: "msg_u", tool: "bash", error: false, bytes: 3 },
      expect.objectContaining({
        kind: "step",
        id: "msg_a",
        turnID: "msg_u",
        providerID: "stub",
        modelID: "m",
        agent: "build",
        cost: 0.5,
        tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 2, cacheWrite: 1 },
      }),
      { kind: "compaction", id: "msg_c", turnID: "msg_c" },
    ])
  })

  test("compaction-anchors hands the compaction request the harness's block with the goal and the reads", async () => {
    const block = "<compaction_anchors>\nGoal: fix it\n</compaction_anchors>"
    const harnessCalls = await harness({ "/harness/adaptive/anchors": { block } })
    const anchors = await plugin("flupcode-compaction-anchors.js")
    const recorded = context("/work/demo")
    await anchors.setup(recorded.ctx)
    recorded.hooks.get("session.context")!({
      sessionID: "ses_1",
      messages: [{ id: "msg_u", role: "user", content: [{ type: "text", text: "fix the build" }] }],
    } as never)
    recorded.hooks.get("tool.execute.after")!({
      sessionID: "ses_1",
      tool: "read",
      input: { path: "/work/demo/a.ts" },
    } as never)
    const compaction = { sessionID: "ses_1", system: [{ type: "text", text: "Summarise." }] }
    await recorded.hooks.get("session.compaction")!(compaction as never)
    expect(harnessCalls.on("/harness/adaptive/anchors")[0]!.body).toEqual({
      projectID: "/work/demo",
      sessionID: "ses_1",
      goal: "fix the build",
      reads: ["/work/demo/a.ts"],
    })
    expect(compaction.system).toEqual([
      { type: "text", text: "Summarise." },
      { type: "text", text: block },
    ])
  })

  test("tool-trim replaces a large output the harness stored, and evidence_read reads it back", async () => {
    const original = "x".repeat(6000)
    const replacement = "head … tail evidence:0123456789abcdef"
    const harnessCalls = await harness({
      "/harness/adaptive/tool-trim": { trimmed: true, ref: "0123456789abcdef", replacement },
      "/harness/adaptive/evidence/read": { text: "lines 1-10" },
    })
    const trim = await plugin("flupcode-tool-trim.js")
    const recorded = context()
    await trim.setup(recorded.ctx)
    const after = {
      sessionID: "ses_1",
      id: "call_1",
      tool: "read",
      status: "completed",
      result: { output: { type: "file" }, content: [{ type: "text", text: original }] },
    }
    await recorded.hooks.get("tool.execute.after")!(after as never)
    expect(after.result as unknown).toEqual({
      output: { type: "file" },
      content: [{ type: "text", text: replacement }],
      metadata: { evidenceRef: "0123456789abcdef" },
    })
    expect(harnessCalls.on("/harness/adaptive/tool-trim")[0]!.body).toEqual({
      sessionID: "ses_1",
      tool: "read",
      callID: "call_1",
      output: original,
    })

    const added: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = []
    recorded.transforms.tool!({ add: (tool: (typeof added)[number]) => added.push(tool) } as never)
    expect(added.map((tool) => tool.name)).toEqual(["evidence_read"])
    expect(await added[0]!.execute({ ref: "0123456789abcdef", range: "1-10" }, { sessionID: "ses_1" })).toEqual({
      content: "lines 1-10",
    })
  })

  test("relevance pins one line to a turn it admitted and renders the same bytes on every request", async () => {
    const line =
      "<skill_relevance>Possibly relevant skills: deploy. Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>"
    const harnessCalls = await harness({ "/harness/adaptive/relevance": { line } })
    const relevance = await plugin("flupcode-relevance.js")
    const recorded = context("/work/demo")
    await relevance.setup(recorded.ctx)
    const request = () => ({
      sessionID: "ses_1",
      messages: [{ id: "msg_u", role: "user", content: [{ type: "text", text: "ship it" }] }] as Array<{
        id?: string
        role: string
        content: unknown[]
      }>,
    })

    // A user message this process never admitted (a session first seen after a restart) is left alone.
    const unknown = request()
    await recorded.hooks.get("session.context")!(unknown as never)
    expect(unknown.messages[0]!.content).toHaveLength(1)

    recorded.hooks.get("session.prompt")!({
      sessionID: "ses_1",
      messageID: "msg_u",
      prompt: { text: "ship it" },
    } as never)
    const first = request()
    await recorded.hooks.get("session.context")!(first as never)
    const second = request()
    second.messages.push({ role: "assistant", content: [{ type: "text", text: "On it" }] })
    await recorded.hooks.get("session.context")!(second as never)

    expect(first.messages[0]!.content).toEqual([
      { type: "text", text: "ship it" },
      { type: "text", text: line },
    ])
    expect(second.messages[0]!.content).toEqual(first.messages[0]!.content)
    expect(harnessCalls.on("/harness/adaptive/relevance").map((hit) => hit.body)).toEqual([
      { projectID: "/work/demo", sessionID: "ses_1", messageID: "msg_u", objective: "ship it" },
    ])
  })
})
