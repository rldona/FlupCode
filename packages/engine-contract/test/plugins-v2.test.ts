import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
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

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    env: {
      // Plugins load only outside pure mode; the harness is the stand-in below.
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: harness.url,
      FLUPCODE_BROWSER_TOKEN: "browser-token",
    },
    prepare: async (home) => {
      installed = (await installEnginePlugins(join(home, ".config", "opencode"), "v2")).paths.map((file) =>
        basename(file),
      )
      // The adaptive plugins only call a loopback harness, and only with the token the harness wrote.
      mkdirSync(join(home, ".config", "flupcode"), { recursive: true })
      writeFileSync(join(home, ".config", "flupcode", "adaptive-token"), "adaptive-token")
      // The deliver plugin registers one tool per profile it finds in the global config.
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
  "flupcode-artifact-write.js": () => {
    expect(readFileSync(join(engine.project, ".flupcode", "artifacts", "report.md"), "utf8")).toBe("# Report")
  },
  "flupcode-episode-events.js": () => {
    const ring = JSON.parse(readFileSync(join(data(), "events", `${sessionID}.json`), "utf8"))
    expect(ring.events).toContainEqual(expect.objectContaining({ kind: "tool.error", tool: "read" }))
  },
  "flupcode-runtime-probe.js": () => {
    // What harness-server needs to know the plugin hooks fire on this engine.
    const probe = JSON.parse(readFileSync(join(data(), "runtime-probe.json"), "utf8"))
    expect(probe).toMatchObject({ hook: "session.context" })
    expect(probe.hookAt).toBeGreaterThanOrEqual(probe.loadedAt)
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
  "flupcode-session-metrics.js": () => {
    const kinds = harness.hits("POST /harness/adaptive/metrics").map((hit) => JSON.parse(hit.body).observation.kind)
    expect(kinds).toEqual(expect.arrayContaining(["step", "tool"]))
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
    expect(JSON.parse(harness.hits("POST /harness/actions/run")[0]!.body)).toMatchObject({
      action: "demo",
      sessionID,
      inputs: { query: "shoes" },
    })
    expect(harness.hits("GET /harness/actions").every((hit) => hit.authorization === "Bearer browser-token")).toBe(true)
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
    const ours = plugins.data.filter((plugin) => plugin.source?.path?.includes("/plugins/flupcode-"))
    expect(Object.fromEntries(ours.map((plugin) => [basename(plugin.source!.path!), plugin.state?.status]))).toEqual(
      Object.fromEntries(installed.map((file) => [file, "active"])),
    )
  })

  for (const [file, check] of Object.entries(evidence)) test(`${file} loads and fires`, check)

  test("nothing lands for a session that does not exist", () => {
    expect(existsSync(join(data(), "events", "undefined.json"))).toBe(false)
  })

  test("the adaptive plugins send the harness's token", () => {
    const adaptive = harness.all().filter((hit) => hit.route.includes("/harness/adaptive/"))
    expect(adaptive.length).toBeGreaterThan(0)
    expect(adaptive.every((hit) => hit.authorization === "Bearer adaptive-token")).toBe(true)
  })
})

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
      if (route === "POST /harness/actions/approve") return Response.json({ data: { approved: true } })
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
