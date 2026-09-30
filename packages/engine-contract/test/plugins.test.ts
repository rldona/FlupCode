import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { startEngine, STUB_MODEL, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
import { startModel } from "../src/model"

/**
 * FlupCode's engine plugins, loaded into a real engine (V2-03).
 *
 * The desktop writes them into the engine's config folder and the engine loads them at startup. A
 * plugin the engine refuses fails silently by design, so the only proof that one works is what it
 * leaves behind: a file it writes, a tool it registers, a call it makes to harness-server. Each test
 * below names that evidence for one plugin, after the same turns the harness drives: a text turn, a
 * large file read, a read that fails, and a compaction.
 */

const model = startModel()
const harness = startHarness()
let engine: Engine
let installed: string[] = []
const sessions = { text: "", read: "", failed: "", compacted: "" }
/** The plugins the engine announced (`plugin.added`) while it booted the project's instance. */
let announced: string[] = []

beforeAll(async () => {
  engine = await startEngine({
    modelUrl: model.url,
    env: {
      // Plugins load only outside pure mode; the harness and the browser runner are the fake below.
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: harness.url,
      FLUPCODE_BROWSER_TOKEN: "browser-token",
    },
    prepare: async (home) => {
      installed = (await installEnginePlugins(join(home, ".config", "opencode"))).paths.map((file) => basename(file))
      // The adaptive plugins only call a loopback harness, and only with the token the harness wrote.
      mkdirSync(join(home, ".config", "flupcode"), { recursive: true })
      writeFileSync(join(home, ".config", "flupcode", "adaptive-token"), "adaptive-token")
      // The deliver plugin registers one tool per profile it finds in the global config.
      writeFileSync(
        join(home, ".config", "opencode", "opencode.json"),
        JSON.stringify({ flupcode: { delivery: { post: { tool: "flupcode_deliver_post", imageRequired: false } } } }),
      )
    },
  })
  const stream = recordEvents(`${engine.url}/event${query()}`, engine.authorization)
  await stream.opened
  const turn = async (name: keyof typeof sessions, text: string, ...replies: Parameters<typeof model.push>) => {
    const session = (await call("POST", `/session${query()}`, {})) as { id: string }
    model.push(...replies)
    await call("POST", `/session/${session.id}/prompt_async${query()}`, {
      model: STUB_MODEL,
      parts: [{ type: "text", text }],
    })
    await stream.until((event) => event.type === "session.idle" && event.data.sessionID === session.id, 60_000)
    sessions[name] = session.id
    return session.id
  }

  writeFileSync(join(engine.project, "large.txt"), `${"contract line\n".repeat(800)}`)
  await turn("text", "hi", { type: "text", text: "Hello" })
  await turn("read", "read the large file", tool("read", { filePath: join(engine.project, "large.txt") }), {
    type: "text",
    text: "Read it",
  })
  await turn("failed", "read a missing file", tool("read", { filePath: join(engine.project, "missing.txt") }), {
    type: "text",
    text: "It is missing",
  })
  const compacted = await turn("compacted", "remember this", { type: "text", text: "Noted" })
  model.push({ type: "text", text: "Summary of the session" })
  await call("POST", `/session/${compacted}/summarize${query()}`, STUB_MODEL)
  await stream.until((event) => event.type === "session.compacted" && event.data.sessionID === compacted, 60_000)
  announced = stream.events.filter((event) => event.type === "plugin.added").map((event) => String(event.data.id))
  stream.close()
}, 180_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
  harness.stop()
})

/** What each plugin leaves behind when it loaded and its hooks fired. */
const evidence: Record<string, () => Promise<void> | void> = {
  "flupcode-reasoning-variants.js": () => {
    // The one plugin written for the embedded v2 loader, which announces what it loads.
    expect(announced).toContain("flupcode-reasoning-variants")
  },
  "flupcode-tool-uses.js": () => {
    expect(existsSync(join(data(), "tool-uses", `${sessions.read}.json`))).toBe(true)
  },
  "flupcode-runtime-probe.js": () => {
    const probe = JSON.parse(readFileSync(join(data(), "runtime-probe.json"), "utf8")) as { hookAt?: number }
    expect(probe.hookAt).toBeGreaterThan(0)
  },
  "flupcode-system-prompt.js": () => {
    expect(readdirSync(join(data(), "system-prompts", sessions.text)).length).toBeGreaterThan(0)
  },
  "flupcode-artifact-write.js": async () => {
    expect(await toolIDs()).toContain("artifact_write")
  },
  "flupcode-deliver.js": async () => {
    expect(await toolIDs()).toContain("flupcode_deliver_post")
  },
  "flupcode-actions.js": async () => {
    expect(harness.hits("GET /harness/actions").every((hit) => hit.authorization === "Bearer browser-token")).toBe(true)
    expect(await toolIDs()).toContain("flupcode_demo_action")
  },
  "flupcode-episode-events.js": () => {
    expect(existsSync(join(data(), "events", `${sessions.failed}.json`))).toBe(true)
  },
  "flupcode-relevance.js": () => {
    expect(harness.hits("POST /harness/adaptive/relevance").length).toBeGreaterThan(0)
  },
  "flupcode-guardrails.js": () => {
    expect(harness.hits("POST /harness/adaptive/guardrails").length).toBeGreaterThan(0)
  },
  "flupcode-session-metrics.js": () => {
    expect(harness.hits("POST /harness/adaptive/metrics").length).toBeGreaterThan(0)
  },
  "flupcode-compaction-anchors.js": () => {
    const anchors = harness.hits("POST /harness/adaptive/anchors")
    expect(anchors.some((hit) => hit.body.includes(sessions.compacted))).toBe(true)
  },
  "flupcode-tool-trim.js": async () => {
    expect(await toolIDs()).toContain("evidence_read")
    expect(harness.hits("POST /harness/adaptive/tool-trim").length).toBeGreaterThan(0)
  },
  "flupcode-cache-selection.js": () => {
    expect(harness.hits("GET /harness/adaptive/selection").length).toBeGreaterThan(0)
  },
}

describe("FlupCode engine plugins", () => {
  test("every installed plugin has evidence to check", () => {
    expect(installed.sort()).toEqual(Object.keys(evidence).sort())
  })

  test("the adaptive plugins send the harness's token", () => {
    const adaptive = harness.all().filter((hit) => hit.route.includes("/harness/adaptive/"))
    expect(adaptive.length).toBeGreaterThan(0)
    expect(adaptive.every((hit) => hit.authorization === "Bearer adaptive-token")).toBe(true)
  })

  for (const [file, check] of Object.entries(evidence)) test(`${file} loads and fires`, check)
})

function tool(name: string, input: unknown) {
  return { type: "tool" as const, name, input }
}

function query() {
  return `?directory=${encodeURIComponent(engine.project)}`
}

function data() {
  return join(engine.home, ".local", "share", "flupcode")
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return response.status === 204 ? undefined : (response.json() as Promise<unknown>)
}

async function toolIDs() {
  return (await call("GET", `/experimental/tool/ids${query()}`)) as string[]
}

/**
 * A stand-in for harness-server: it records every call, serves one web-action profile, and answers
 * the adaptive routes with an empty body, which every plugin reads as "change nothing".
 */
function startHarness() {
  const calls: Array<{ route: string; authorization: string | null; body: string }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const route = `${request.method} ${new URL(request.url).pathname}`
      calls.push({ route, authorization: request.headers.get("authorization"), body: await request.text() })
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
      return Response.json({})
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits: (route: string) => calls.filter((call) => call.route === route),
    all: () => calls,
    stop: () => server.stop(true),
  }
}
