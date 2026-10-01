import { mcpStdioCommand } from "@flupcode/engine-contract/mcp"
import { startEngine } from "@flupcode/engine-contract/engine"
import { startModel, type Reply } from "@flupcode/engine-contract/model"

/**
 * The live-engine Playwright project's engine (V2-43): the pinned OpenCode 2 binary, isolated, with
 * the stub model and one stdio MCP server, behind a proxy on a fixed port the app is pointed at.
 *
 * 2.x always asks for a password and a page in a browser cannot send one, so the proxy adds the
 * engine's credential to every call, as the desktop app does for its renderer, and answers CORS for
 * the preview's origin. `/__fixture` is the tests' side door: where the project lives, and the replies
 * the stub model gives next. Run by Playwright as a web server, with Bun:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun e2e-engine/fixture.ts
 */
const FIXTURE_PORT = 4197

const model = startModel()
const engine = await startEngine({
  modelUrl: model.url,
  config: {
    mcp: { contract: { type: "local", command: mcpStdioCommand() } },
    // 2.x enables OpenCode Zen with a public key out of the box. On a runner with a network the app
    // could pick one of its free models and the specs would talk to a real model instead of the stub.
    disabled_providers: ["opencode"],
  },
})

const cors = (origin: string | null) => ({
  "access-control-allow-origin": origin ?? "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
})

Bun.serve({
  port: FIXTURE_PORT,
  hostname: "127.0.0.1",
  // Event streams stay open for the whole test.
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) })
    if (url.pathname === "/__fixture") return Response.json({ project: engine.project }, { headers: cors(origin) })
    if (url.pathname === "/__fixture/model" && request.method === "POST") {
      model.reset()
      model.push(...((await request.json()) as Reply[]))
      return new Response(null, { status: 204, headers: cors(origin) })
    }
    const forwarded = new Request(`${engine.url}${url.pathname}${url.search}`, request)
    forwarded.headers.set("authorization", engine.authorization)
    // The engine compresses; handing a compressed body on with its length unchanged breaks the page.
    forwarded.headers.set("accept-encoding", "identity")
    const response = await fetch(forwarded)
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    Object.entries(cors(origin)).forEach(([key, value]) => headers.set(key, value))
    return new Response(response.body, { status: response.status, headers })
  },
})

const stop = async () => {
  await engine.stop()
  model.stop()
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
console.log(`OpenCode ${engine.detected.kind} for the live-engine e2e on http://127.0.0.1:${FIXTURE_PORT}`)
