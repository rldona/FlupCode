import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { mcpStdioCommand } from "../src/mcp"
import { startModel } from "../src/model"

/**
 * Per-server MCP use and latency on OpenCode 2 (H-16). 2.x offers MCP tools only inside Code Mode's
 * `execute`, never as tools of their own, yet each call a script makes still runs the tool hooks under
 * the server-prefixed name 1.x used (`contract_echo`). FlupCode's tool-uses plugin therefore counts
 * and times it, which is all the Context panel's per-server figures read. Runs on the v2 line:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/mcp-stats-v2.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    env: { OPENCODE_PURE: undefined },
    config: { mcp: { contract: { type: "local", command: mcpStdioCommand() } } },
    prepare: async (home) => {
      await installEnginePlugins(join(home, ".config", "opencode"))
    },
  })
}, 120_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("MCP calls on OpenCode 2", () => {
  test("a server's tool called from Code Mode is counted and timed under the server's name", async () => {
    await until(
      async () =>
        ((await call("GET", "/api/mcp")) as { data: Array<{ status: { status: string } }> }).data[0]?.status.status,
      (status) => status === "connected",
    )
    const session = (
      (await call("POST", "/api/session", { location: { directory: engine.project }, agent: "build" })) as {
        data: { id: string }
      }
    ).data
    await call("PATCH", `/api/session/${session.id}`, {
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    // A connected server joins Code Mode's catalog when a turn next builds it; a first turn does that.
    model.push({ type: "text", text: "Ready" })
    await call("POST", `/api/session/${session.id}/prompt`, { text: "ready?" })
    await call("POST", `/api/experimental/session/${session.id}/wait`)
    model.push(
      { type: "tool", name: "execute", input: { code: "return await tools.contract.echo({ text: 'hi' })" } },
      { type: "text", text: "Done" },
    )
    await call("POST", `/api/session/${session.id}/prompt`, { text: "echo hi" })
    await call("POST", `/api/experimental/session/${session.id}/wait`)

    // 2.x never offered the MCP tool on its own: only through `execute`.
    const offered = (model.requests.at(-1) as { tools?: Array<{ function?: { name?: string } }> }).tools?.map(
      (tool) => tool.function?.name,
    )
    expect(offered).toContain("execute")
    expect(offered).not.toContain("contract_echo")
    const uses = await until(
      async () =>
        JSON.parse(
          readFileSync(join(engine.home, ".local", "share", "flupcode", "tool-uses", `${session.id}.json`), "utf8"),
        ) as { tools: Record<string, { count: number }>; calls: Array<{ tool: string; ms?: number }> },
      (value) => value.calls.some((entry) => entry.tool === "contract_echo"),
    )
    expect(uses.tools.contract_echo?.count).toBe(1)
    expect(uses.calls.find((entry) => entry.tool === "contract_echo")?.ms).toEqual(expect.any(Number))
  })
})

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read().catch(() => undefined as T)
    if (value !== undefined && match(value)) return value
    if (Date.now() > deadline) throw new Error(`Never matched: ${JSON.stringify(value).slice(0, 300)}`)
    await Bun.sleep(250)
  }
}
