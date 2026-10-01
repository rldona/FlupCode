import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
import { startModel } from "../src/model"

/**
 * FlupCode's OpenCode 2 plugins, loaded into the pinned 2.x engine (V2-30). Like the 1.x smoke test
 * (`plugins.test.ts`), each plugin is proven by what it leaves behind after one turn that runs a
 * failing shell command, keeps a document and reads with arguments the tool refuses. Runs on the v2
 * line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/plugins-v2.test.ts
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let installed: string[] = []
let sessionID = ""

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    env: {
      // Plugins load only outside pure mode.
      OPENCODE_PURE: undefined,
    },
    prepare: async (home) => {
      installed = (await installEnginePlugins(join(home, ".config", "opencode"), "v2")).paths.map((file) =>
        basename(file),
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
  sessionID = ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id
  model.push(
    { type: "tool", name: "shell", input: { command: "echo broken && exit 3", description: "Fail" } },
    { type: "tool", name: "artifact_write", input: { title: "Report", filename: "report.md", content: "# Report" } },
    // Without its `path`, 2.x refuses the call: a tool that ends in error.
    { type: "tool", name: "read", input: {} },
    { type: "text", text: "Done" },
  )
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "go" })
  await stream.until(
    (event) => event.type === "session.execution.succeeded" && event.data.sessionID === sessionID,
    60_000,
  )
  stream.close()
}, 180_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
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
    expect(ring.events).toEqual([expect.objectContaining({ kind: "tool.error", tool: "read" })])
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
