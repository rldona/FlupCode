import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { mcpStdioCommand, startOAuthMcp } from "@flupcode/engine-contract/mcp"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { EngineError } from "./error"
import { createV2Domains } from "./v2"

/**
 * MCP through the OpenCode 2 adapter against a real 2.x engine (V2-23): a stdio server that lists,
 * connects and answers a tool call, and a remote one signed in with OAuth against a stub
 * authorization server. Every request names its folder in `location[directory]`, never
 * `?directory=`, which the engine records below. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-mcp.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const remote = startOAuthMcp()
const requested: string[] = []
const opened: string[] = []
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    config: {
      mcp: {
        contract: { type: "local", command: mcpStdioCommand() },
        remote: { type: "remote", url: remote.url },
      },
    },
  })
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      requested.push(request.url)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  // The reader's browser, standing in: following the sign-in URL ends at the engine's callback.
  domains = createV2Domains(engine.url, {
    openUrl: (url) => {
      opened.push(url)
      void fetch(url)
    },
  })
})

beforeEach(() => model.reset())

afterAll(async () => {
  await engine?.stop()
  model.stop()
  remote.stop()
})

describe.skipIf(!run)("MCP on the OpenCode 2 adapter", () => {
  test("a stdio server is listed connected, exposes its resource, and answers a tool call", async () => {
    const server = await status("contract", (value) => value === "connected")
    expect(server).toMatchObject({ name: "contract", status: { status: "connected" } })
    expect(await domains.mcp.resources({ directory: engine.project })).toContainEqual({
      name: "notes",
      uri: "contract://notes",
      description: "Contract notes",
      mimeType: "text/plain",
      client: "contract",
    })

    // 2.x puts MCP tools behind Code Mode: the model calls them from code it hands `execute`. A server
    // that connects after the engine started has its tools registered a moment later (the app hears
    // `mcp.tools.changed`), so the turn is repeated until the tool is there.
    const tool = await echoThroughCodeMode()
    expect(tool).toMatchObject({ type: "tool", name: "execute", state: { status: "completed" } })
    expect(JSON.stringify(tool)).toContain("echo: hi")
  })

  test("disconnecting and connecting again moves the server's status", async () => {
    await status("contract", (value) => value === "connected")
    await domains.mcp.disconnect({ server: "contract", directory: engine.project })
    await status("contract", (value) => value === "disabled")
    await domains.mcp.connect({ server: "contract", directory: engine.project })
    await status("contract", (value) => value === "connected")
  })

  test("a remote server waits on sign-in, signs in through OAuth, then connects and can sign out", async () => {
    await status("remote", (value) => value === "needs_auth")
    const started = await domains.mcp.authStart({ server: "remote", directory: engine.project })
    expect(started.authorizationUrl).toContain("/authorize")
    await domains.mcp.authenticate({ server: "remote", directory: engine.project })
    expect(opened).toContain(started.authorizationUrl)
    expect(remote.authorized()).toBe(1)
    await status("remote", (value) => value === "connected")

    await domains.mcp.authRemove({ server: "remote", directory: engine.project })
    await domains.mcp.disconnect({ server: "remote", directory: engine.project })
    await domains.mcp.connect({ server: "remote", directory: engine.project }).catch(() => undefined)
    await status("remote", (value) => value === "needs_auth")
  })

  test("without a config store, saving a server says why (see v2-config.engine.test.ts)", async () => {
    const refused = await domains.mcp
      .add({ server: "new", config: { type: "local", command: ["true"] }, directory: engine.project })
      .catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(EngineError)
    expect((refused as EngineError).tag).toBe("UnsupportedByEngine")
  })

  test("no request names its folder with ?directory=", () => {
    expect(requested.length).toBeGreaterThan(0)
    expect(requested.filter((url) => new URL(url).searchParams.has("directory"))).toEqual([])
  })
})

async function echoThroughCodeMode() {
  const deadline = Date.now() + 30_000
  for (;;) {
    const session = await domains.session.create({ location: { directory: engine.project } })
    const code = `if (!Object.keys(tools).includes("contract")) return "not yet"; return await tools.contract.echo({ text: "hi" })`
    model.push({ type: "tool", name: "execute", input: { code } })
    model.push({ type: "text", text: "Echoed" })
    await domains.session.prompt({ sessionID: session.id, text: "echo hi" })
    await domains.session.wait({ sessionID: session.id })
    const messages = (await domains.message.list({ sessionID: session.id })).data
    const tool = messages.flatMap((message) => (message.type === "assistant" ? message.content : []))[0]
    const output = tool?.type === "tool" && tool.state.status === "completed" ? JSON.stringify(tool.state.content) : ""
    if (!output.includes("not yet") || Date.now() > deadline) return tool
    await Bun.sleep(200)
  }
}

/** The server once its status passes `match`, or the last one seen after 30s. */
async function status(name: string, match: (status: string | undefined) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const servers = (await domains.mcp.list({ directory: engine.project })).data
    const server = servers.find((item) => item.name === name)
    const current = (server?.status as { status?: string } | undefined)?.status
    if (match(current)) return server
    if (Date.now() > deadline) throw new Error(`MCP server ${name} stayed ${current}: ${JSON.stringify(server)}`)
    await Bun.sleep(100)
  }
}
