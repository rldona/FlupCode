import { mcpStdioCommand } from "@flupcode/engine-contract/mcp"
import { startEngine } from "@flupcode/engine-contract/engine"
import { startModel, type Reply } from "@flupcode/engine-contract/model"
import { startEngineProxy } from "@flupcode/remote/engine-proxy"

/**
 * The live-engine Playwright project's engine (V2-43): the pinned OpenCode 2 binary, isolated, with
 * the stub model and one stdio MCP server, behind FlupCode's engine proxy on a fixed port the app is
 * pointed at: 2.x always asks for a password and a page in a browser cannot send one. Run by
 * Playwright as a web server, with Bun:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun e2e-engine/fixture.ts
 */
const FIXTURE_PORT = 4187
const CONTROL_PORT = 4189

const model = startModel()
const engine = await startEngine({
  modelUrl: model.url,
  // Priced, so the cost the app shows can be held against the engine's own (TI-05).
  price: { input: 1000, output: 2000 },
  config: {
    mcp: { contract: { type: "local", command: mcpStdioCommand() } },
    // 2.x enables OpenCode Zen with a public key out of the box. On a runner with a network the app
    // could pick one of its free models and the specs would talk to a real model instead of the stub.
    disabled_providers: ["opencode"],
  },
})

// The app reaches the engine through FlupCode's own engine proxy, the one the desktop app and
// `flupcode serve` put in front of OpenCode 2, so the specs drive the path a reader's browser takes.
// The preview build the specs open is the one page it serves besides FlupCode's own.
const proxy = await startEngineProxy({
  port: FIXTURE_PORT,
  engine: engine.url,
  authorization: engine.authorization,
  origins: ["http://localhost:4173"],
})

// The specs' side door, apart from the engine's address: where the project lives, and the replies
// the stub model gives next.
Bun.serve({
  port: CONTROL_PORT,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/__fixture") return Response.json({ project: engine.project })
    if (url.pathname === "/__fixture/model" && request.method === "POST") {
      model.reset()
      model.push(...((await request.json()) as Reply[]))
      return new Response(null, { status: 204 })
    }
    return new Response("not found", { status: 404 })
  },
})

const stop = async () => {
  await proxy.close()
  await engine.stop()
  model.stop()
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
console.log(`OpenCode ${engine.detected.kind} for the live-engine e2e on ${proxy.url}`)
