import { join } from "node:path"

/**
 * MCP servers for the contract tests (V2-23), written against the protocol rather than an SDK so the
 * suite adds no dependency: one tool, `echo`, and one resource, `contract://notes`, so a test can
 * tell a server was really reached.
 *
 * Two ways to reach it: a stdio command (`mcpStdioCommand`), and a remote server behind OAuth
 * (`startOAuthMcp`) with its own authorization server, which signs anyone in without a prompt.
 */

/** The command an engine config runs to start the stdio server. */
export function mcpStdioCommand() {
  return [process.execPath, join(import.meta.dir, "mcp-stdio.ts")]
}

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message in, its reply out; notifications get none. */
export function answer(message: Message) {
  if (message.id === undefined) return undefined
  const result = (() => {
    if (message.method === "initialize")
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "contract", version: "1.0.0" },
      }
    if (message.method === "ping") return {}
    if (message.method === "tools/list")
      return {
        tools: [
          {
            name: "echo",
            description: "Repeats the text it is given",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      }
    if (message.method === "tools/call") {
      const text = (message.params?.arguments as { text?: string } | undefined)?.text ?? ""
      return { content: [{ type: "text", text: `echo: ${text}` }] }
    }
    if (message.method === "resources/list")
      return {
        resources: [{ uri: "contract://notes", name: "notes", description: "Contract notes", mimeType: "text/plain" }],
      }
    if (message.method === "resources/templates/list") return { resourceTemplates: [] }
    if (message.method === "resources/read")
      return { contents: [{ uri: "contract://notes", mimeType: "text/plain", text: "contract notes" }] }
    return undefined
  })()
  if (result === undefined)
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No method ${message.method}` } }
  return { jsonrpc: "2.0", id: message.id, result }
}

const TOKEN = "contract-token"

/**
 * A remote MCP server at `/mcp` that answers 401 until it gets a token, and the authorization server
 * that hands one out: RFC 9728 discovery, dynamic client registration, an authorize endpoint that
 * redirects straight back with a code, and a token endpoint. `authorized` counts the tokens issued.
 */
export function startOAuthMcp() {
  let issued = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const origin = url.origin
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>
        return Response.json(
          { ...body, client_id: "contract-client", token_endpoint_auth_method: "none" },
          { status: 201 },
        )
      }
      if (url.pathname === "/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "")
        back.searchParams.set("code", "contract-code")
        const state = url.searchParams.get("state")
        if (state) back.searchParams.set("state", state)
        return Response.redirect(back.href, 302)
      }
      if (url.pathname === "/token" && request.method === "POST") {
        issued++
        return Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 3600 })
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        })
      // No server-initiated stream: replies come back on the POST that asked.
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const reply = answer((await request.json()) as Message)
      if (!reply) return new Response(null, { status: 202 })
      return Response.json(reply)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authorized: () => issued,
    stop: () => server.stop(true),
  }
}
