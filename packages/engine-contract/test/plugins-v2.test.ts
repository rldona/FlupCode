import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { enginePluginFolders } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents, type EngineEvent } from "../src/events"
import { startModel } from "../src/model"

/**
 * FlupCode's OpenCode 2 plugins, loaded into the pinned 2.x engine (V2-30). Like the 1.x smoke test
 * (`plugins.test.ts`), each plugin is proven by what it leaves behind: a file it writes, or a call it
 * makes to a stand-in for harness-server. The session runs one turn (a failing shell command, a kept
 * document, a refused read, a large read the trim is asked about, an evidence read) and is compacted.
 * Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/plugins-v2.test.ts
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
const harness = startHarness()
let engine: Engine
let installed: string[] = []
let sessionID = ""
let planSession = ""
let failSession = ""
let events: EngineEvent[] = []

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    env: {
      // Plugins load only outside pure mode; the harness is the stand-in below.
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: harness.url,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    flupcodePlugins: true,
    prepare: async (home) => {
      installed = enginePluginFolders({ XDG_CONFIG_HOME: join(home, ".config") }, home).map(
        (folder) => `${basename(folder)}.js`,
      )
      // The adaptive plugins only call a loopback harness, and only with the token the harness wrote.
      mkdirSync(join(home, ".config", "flupcode"), { recursive: true })
      writeFileSync(join(home, ".config", "flupcode", "adaptive-token"), "adaptive-token")
      // The deliver plugin registers one tool per profile it finds in the global config.
      mkdirSync(join(home, ".config", "opencode"), { recursive: true })
      writeFileSync(
        join(home, ".config", "opencode", "opencode.json"),
        JSON.stringify({ flupcode: { delivery: { post: { tool: "flupcode_deliver_post", imageRequired: false } } } }),
      )
      // The models.dev cache reasoning-variants reads, with effort levels for the stub model.
      mkdirSync(join(home, ".cache", "opencode"), { recursive: true })
      writeFileSync(
        join(home, ".cache", "opencode", "models.json"),
        JSON.stringify({
          stub: { models: { "stub-model": { reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
        }),
      )
    },
  })
  const stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
  await stream.opened
  writeFileSync(join(engine.project, "large.txt"), "contract line\n".repeat(800))
  sessionID = ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id
  model.push(
    { type: "tool", name: "shell", input: { command: "echo broken && exit 3", description: "Fail" } },
    { type: "tool", name: "artifact_write", input: { title: "Report", filename: "report.md", content: "# Report" } },
    // Without its `path`, 2.x refuses the call: a tool that ends in error.
    { type: "tool", name: "read", input: {} },
    { type: "tool", name: "read", input: { path: join(engine.project, "large.txt") } },
    { type: "tool", name: "evidence_read", input: { ref: "0123456789abcdef", range: "1-10" } },
    { type: "tool", name: "flupcode_demo_action", input: { query: "shoes" } },
    { type: "tool", name: "flupcode_deliver_post", input: { text: "The piece", template: "plain" } },
    { type: "text", text: "Done" },
  )
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "go" })
  await stream.until(
    (event) => event.type === "session.execution.succeeded" && event.data.sessionID === sessionID,
    60_000,
  )
  // The stub's summary is not the template 2.x asks for, so the compaction fails, after its request.
  model.push({ type: "text", text: "Summary" })
  await call("POST", `/api/session/${sessionID}/compact`, {})
  await stream.until(
    (event) =>
      event.type.startsWith("session.compaction.") &&
      event.type !== "session.compaction.started" &&
      event.type !== "session.compaction.delta" &&
      event.data.sessionID === sessionID,
    60_000,
  )
  // The permission floor: a session that allows everything, on the plan agent, asked to edit.
  writeFileSync(join(engine.project, "plan-target.txt"), "untouched\n")
  planSession = (
    (await call("POST", "/api/session", { permissions: [{ action: "*", resource: "*", effect: "allow" }] })) as {
      data: { id: string }
    }
  ).data.id
  await call("POST", `/api/session/${planSession}/agent`, { agent: "plan" })
  model.push(
    {
      type: "tool",
      name: "edit",
      input: { path: join(engine.project, "plan-target.txt"), oldString: "untouched", newString: "edited" },
    },
    { type: "text", text: "Tried" },
  )
  await call("POST", `/api/session/${planSession}/prompt`, { text: "edit it" })
  await stream.until(
    (event) =>
      event.type.startsWith("session.execution.") &&
      event.type !== "session.execution.started" &&
      event.data.sessionID === planSession,
    60_000,
  )
  // A step the provider refuses: the failed step the usage ledger keeps (UL-02).
  failSession = ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id
  model.push({ type: "error", status: 400, message: "Bad request from provider" })
  await call("POST", `/api/session/${failSession}/prompt`, { text: "fail" })
  await stream.until(
    (event) => event.type === "session.execution.failed" && event.data.sessionID === failSession,
    60_000,
  )
  events = stream.events
  stream.close()
}, 180_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
  harness.stop()
})

/** What each plugin leaves behind when it loaded and its hooks fired. */
const evidence: Record<string, () => Promise<void> | void> = {
  "flupcode-reasoning-variants.js": async () => {
    const models = (await call("GET", "/api/model")) as {
      data: Array<{ id: string; variants?: Array<{ id: string }> }>
    }
    const stub = models.data.find((item) => item.id === "stub-model")
    // Without the plugin 2.x lists no levels for it at all; with it, the levels models.dev names (2.x
    // fills in the steps between them).
    expect(stub?.variants?.map((variant) => variant.id)).toEqual(expect.arrayContaining(["low", "high"]))
  },
  "flupcode-tool-uses.js": () => {
    const uses = JSON.parse(readFileSync(join(data(), "tool-uses", `${sessionID}.json`), "utf8"))
    expect(Object.keys(uses.tools)).toEqual(expect.arrayContaining(["bash", "artifact_write", "read"]))
    const signals = JSON.parse(readFileSync(join(data(), "episode-signals", `${sessionID}.json`), "utf8"))
    expect(signals.calls).toContainEqual(
      expect.objectContaining({ tool: "bash", ok: true, command: "echo broken && exit 3", exit: 3 }),
    )
  },
  "flupcode-system-prompt.js": () => {
    const folder = join(data(), "system-prompts", sessionID)
    const [first] = readdirSync(folder)
    const recorded = JSON.parse(readFileSync(join(folder, first!), "utf8"))
    expect(recorded).toMatchObject({ providerID: "stub", modelID: "stub-model" })
    expect(recorded.system.join("\n")).toContain("OpenCode")
  },
  "flupcode-artifact-write.js": async () => {
    expect(readFileSync(join(engine.project, ".flupcode", "artifacts", "report.md"), "utf8")).toBe("# Report")
    // The write is reported as it happens (RP-03), with the plugins' token: which file, which session
    // and the assistant message whose turn called the tool. No run or task: those are the server's.
    const posts = harness.hits("POST /harness/artifacts/index")
    expect(posts).toHaveLength(1)
    expect(posts[0]!.authorization).toBe("Bearer plugin-token")
    const messages = (
      (await call("GET", `/api/session/${sessionID}/message?limit=200`)) as {
        data: Array<{ id: string; type: string; content?: Array<{ type: string; name?: string }> }>
      }
    ).data
    const writer = messages.find((message) =>
      (message.content ?? []).some((part) => part.type === "tool" && part.name === "artifact_write"),
    )
    expect(JSON.parse(posts[0]!.body)).toEqual({
      kind: "document",
      directory: engine.project,
      path: join(".flupcode", "artifacts", "report.md"),
      title: "Report",
      sessionID,
      messageID: writer!.id,
    })
  },
  "flupcode-episode-events.js": () => {
    const ring = JSON.parse(readFileSync(join(data(), "events", `${sessionID}.json`), "utf8"))
    expect(ring.events).toContainEqual(expect.objectContaining({ kind: "tool.error", tool: "read" }))
  },
  "flupcode-runtime-probe.js": async () => {
    // What harness-server needs to know the plugin hooks fire on this engine: the plugin's own answer
    // over the RPC (V2-51), and the canary file it still writes.
    const ack = (await call("POST", "/api/rpc/flupcode.runtime/ack", { input: {} })) as {
      output: { token: string; loadedAt: number; hookAt: number; hook: string }
    }
    expect(ack.output).toMatchObject({ token: expect.any(String), hook: "session.context" })
    expect(ack.output.hookAt).toBeGreaterThanOrEqual(ack.output.loadedAt)
    const probe = JSON.parse(readFileSync(join(data(), "runtime-probe.json"), "utf8"))
    expect(probe).toMatchObject({ token: ack.output.token, hook: "session.context" })
  },
  "flupcode-relevance.js": () => {
    expect(harness.hits("POST /harness/adaptive/relevance")).toContainEqual(
      expect.objectContaining({ body: expect.stringContaining('"objective":"go"') }),
    )
  },
  "flupcode-guardrails.js": () => {
    const calls = harness.hits("POST /harness/adaptive/guardrails").map((hit) => JSON.parse(hit.body).observation)
    expect(calls).toContainEqual(expect.objectContaining({ kind: "call", tool: "bash" }))
    expect(calls).toContainEqual(expect.objectContaining({ kind: "error", tool: "read" }))
  },
  "flupcode-session-metrics.js": async () => {
    const kinds = harness.hits("POST /harness/adaptive/metrics").map((hit) => JSON.parse(hit.body).observation.kind)
    expect(kinds).toEqual(expect.arrayContaining(["step", "tool"]))
    // The usage ledger's rows (UL-02), with the plugins' token, keyed as message.list names them.
    const posts = harness.hits("POST /harness/usage/events")
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every((hit) => hit.authorization === "Bearer plugin-token")).toBe(true)
    const bodies = posts.map((hit) => JSON.parse(hit.body) as { events: Ledger[]; tools: Ledger[] })
    const rows = bodies.flatMap((body) => body.events)
    const tools = bodies.flatMap((body) => body.tools)
    const messages = (
      (await call("GET", `/api/session/${sessionID}/message?limit=200`)) as {
        data: Array<{ id: string; type: string; content?: Array<{ type: string; id?: string }> }>
      }
    ).data
    const steps = messages
      .filter((message) => message.type === "assistant")
      .map((message) => `${sessionID}:step:${message.id}`)
    expect(
      rows
        .filter((row) => row.kind === "step" && row.sessionID === sessionID)
        .map((row) => row.id)
        .sort(),
    ).toEqual(steps.sort())
    const compaction = messages.find((message) => message.type === "compaction")!
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: `${sessionID}:compaction:${compaction.id}`,
        kind: "compaction",
        errorType: "compaction.failed",
      }),
    )
    const calls = messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool")
    expect(
      tools
        .filter((tool) => tool.sessionID === sessionID)
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(calls.map((part) => `${sessionID}:tool:${part.id}`).sort())
    expect(rows).toContainEqual(expect.objectContaining({ kind: "step_failed", sessionID: failSession }))
  },
  "flupcode-compaction-anchors.js": () => {
    const anchors = harness.hits("POST /harness/adaptive/anchors")
    expect(anchors.some((hit) => hit.body.includes(sessionID) && hit.body.includes('"goal":"go"'))).toBe(true)
  },
  "flupcode-actions.js": () => {
    // Asked first, then run: on 2.x the approval is the harness's to ask, in the session.
    const routes = harness
      .all()
      .filter((hit) => hit.route.startsWith("POST /harness/actions/"))
      .map((hit) => hit.route)
    expect(routes).toEqual(["POST /harness/actions/approve", "POST /harness/actions/run"])
    expect(JSON.parse(harness.hits("POST /harness/actions/approve")[0]!.body)).toMatchObject({
      action: "demo",
      sessionID,
      inputs: { query: "shoes" },
    })
    // The run presents the single-use id the approval returned (TI-09).
    expect(JSON.parse(harness.hits("POST /harness/actions/run")[0]!.body)).toMatchObject({
      action: "demo",
      sessionID,
      inputs: { query: "shoes" },
      approval: "apr_1",
    })
    expect(harness.hits("GET /harness/actions").every((hit) => hit.authorization === "Bearer plugin-token")).toBe(true)
  },
  "flupcode-deliver.js": async () => {
    const messages = (await call("GET", `/api/session/${sessionID}/message?limit=200`)) as {
      data: Array<{
        type: string
        content?: Array<{
          type: string
          name?: string
          state?: { status?: string; content?: Array<{ text?: string }> }
        }>
      }>
    }
    const delivered = messages.data
      .flatMap((message) => message.content ?? [])
      .find((item) => item.type === "tool" && item.name === "flupcode_deliver_post")
    expect(delivered?.state?.status).toBe("completed")
    expect(JSON.stringify(delivered?.state?.content)).toContain("The piece")
  },
  "flupcode-memory.js": () => {
    // The store opens on the first request it retrieves for.
    expect(existsSync(join(data(), "memory.db"))).toBe(true)
  },
  "flupcode-agents.js": async () => {
    const cowork = (await call("GET", "/api/agent/cowork")) as { data: { id: string; hidden: boolean } }
    expect(cowork.data).toMatchObject({ id: "cowork", hidden: true })
    // The plan agent denies edits, and the session's `*: allow` does not override it.
    expect(readFileSync(join(engine.project, "plan-target.txt"), "utf8")).toBe("untouched\n")
  },
  "flupcode-browser-mcp.js": () => {
    // No browser server is configured here: every tool this suite ran went by without asking. The
    // approvals themselves are proved in harness-server's `browser-mcp.engine.test.ts` (BU-02).
    expect(harness.hits("POST /harness/browser-mcp/decide")).toEqual([])
    expect(harness.hits("POST /harness/browser-mcp/observe")).toEqual([])
  },
  "flupcode-cache-selection.js": () => {
    expect(harness.hits("GET /harness/adaptive/selection").length).toBeGreaterThan(0)
  },
  "flupcode-tool-trim.js": () => {
    expect(harness.hits("POST /harness/adaptive/tool-trim")).toContainEqual(
      expect.objectContaining({ body: expect.stringContaining('"tool":"read"') }),
    )
    expect(harness.hits("POST /harness/adaptive/evidence/read").length).toBe(1)
  },
}

describe.skipIf(!run)("FlupCode's OpenCode 2 plugins", () => {
  test("every installed plugin has evidence to check, and the engine reports each one active", async () => {
    expect(installed.sort()).toEqual(Object.keys(evidence).sort())
    const plugins = (await call("GET", "/api/plugin")) as {
      data: Array<{ source?: { path?: string }; state?: { status?: string; error?: string } }>
    }
    // Each from its own folder under FlupCode's config folder (HE-04): `<folder>/index.js`.
    const ours = plugins.data.filter((plugin) => plugin.source?.path?.includes("/flupcode/engine-plugins/"))
    expect(
      Object.fromEntries(ours.map((plugin) => [`${basename(dirname(plugin.source!.path!))}.js`, plugin.state?.status])),
    ).toEqual(Object.fromEntries(installed.map((file) => [file, "active"])))
  })

  for (const [file, check] of Object.entries(evidence)) test(`${file} loads and fires`, check)

  test("nothing lands for a session that does not exist", () => {
    expect(existsSync(join(data(), "events", "undefined.json"))).toBe(false)
  })

  test("billable events reach plugins as the usage ledger expects them (UL-02)", async () => {
    const mine = (type: string, session = sessionID) =>
      events.filter((event) => event.type === type && event.data.sessionID === session)
    // A refused step fails with its error and, on 2.0.18, without a cost.
    const [failed] = mine("session.step.failed", failSession)
    expect(failed?.data).toMatchObject({
      assistantMessageID: expect.any(String),
      error: { type: "provider.invalid-request" },
    })
    expect(failed?.data).not.toHaveProperty("cost")
    // A step that ends carries its cost and usage.
    expect(mine("session.step.ended")[0]?.data).toMatchObject({
      cost: expect.any(Number),
      tokens: { input: 10, output: 5 },
    })
    // A compaction that called the model carries what it spent, failed or not, its second attempt
    // (the template reminder) included; the message it fills is named by the started event's inputID.
    const [started] = mine("session.compaction.started")
    expect(started?.data).toMatchObject({ inputID: expect.stringMatching(/^msg_/) })
    expect(mine("session.compaction.failed")[0]?.data).toMatchObject({
      cost: expect.any(Number),
      tokens: { input: 20, output: 10 },
    })
    // session.usage.recorded (the title's and the compaction's) reaches no subscriber, and the
    // session log replays nothing: the title has no ledger row until a pin changes either.
    expect(events.some((event) => event.type === "session.usage.recorded")).toBe(false)
    const log = await fetch(`${engine.url}/api/experimental/session/${sessionID}/log?after=0`, {
      headers: { authorization: engine.authorization, "x-opencode-directory": encodeURIComponent(engine.project) },
    })
    expect(
      (await log.text())
        .trim()
        .split("\n\n")
        .map((frame) => JSON.parse(frame.replace(/^data: /, "")).type),
    ).toEqual(["log.synced"])
  })

  test("the adaptive plugins send the harness's token", () => {
    const adaptive = harness.all().filter((hit) => hit.route.includes("/harness/adaptive/"))
    expect(adaptive.length).toBeGreaterThan(0)
    expect(adaptive.every((hit) => hit.authorization === "Bearer adaptive-token")).toBe(true)
  })
})

type Ledger = { id: string; kind?: string; sessionID: string; errorType?: string }

function data() {
  return join(engine.home, ".local", "share", "flupcode")
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: {
      authorization: engine.authorization,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(engine.project),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return response.status === 204 ? undefined : (response.json() as Promise<unknown>)
}

/** A stand-in for harness-server: it records every call and answers with an empty body. */
function startHarness() {
  const calls: Array<{ route: string; authorization: string | null; body: string }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
      const route = calls.at(-1)!.route
      if (route === "GET /harness/actions")
        return Response.json({
          data: {
            profiles: [
              {
                id: "demo",
                tool: "flupcode_demo_action",
                origin: "https://example.com",
                description: "A demo action",
                inputs: { query: "string" },
                steps: [],
              },
            ],
          },
        })
      if (route === "POST /harness/actions/approve")
        return Response.json({ data: { approved: true, approval: "apr_1" } })
      return Response.json({ data: {} })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits: (route: string) => calls.filter((call) => call.route === route),
    all: () => calls,
    stop: () => server.stop(true),
  }
}
