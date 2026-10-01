import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { connect } from "node:net"
import { Readable, type Duplex } from "node:stream"

/**
 * The OpenCode 2 engine at a loopback address the web app can use (2.1): 2.x always asks for a
 * password and a web page has no way to send one, so this sits in front of it and signs in for the
 * page, as the desktop app does for its own window.
 *
 * The password is what keeps any page open in the reader's browser from driving the agent, so the
 * proxy keeps that line itself: a request a browser makes is served only when its `Origin` is FlupCode's
 * web app (or one the reader added), and only at a loopback `Host`, which a DNS-rebinding page cannot
 * name. A request no browser made (no `Origin`, no `Sec-Fetch-Site`: harness-server, the CLI) is a
 * process on this computer and is served as the engine would serve it. Node and Bun both run this:
 * the desktop's main process is Electron.
 */
export async function startEngineProxy(input: {
  /** Where the proxy listens: a loopback host and the port the web app asks (4096). */
  hostname?: string
  port: number
  /** The engine behind it and the credential it signs in with. */
  engine: string
  authorization: string
  /** Browser origins served besides FlupCode's web app and `FLUPCODE_WEB_ORIGINS`. */
  origins?: string[]
}) {
  const hostname = input.hostname ?? "127.0.0.1"
  const engine = new URL(input.engine)
  const origins = new Set([...WEB_ORIGINS, ...extraOrigins(), ...(input.origins ?? [])])
  const hosts = new Set(["127.0.0.1", "localhost", "[::1]"].map((host) => `${host}:${input.port}`))

  const server = createServer((request, response) => {
    const refusal = refuse(request, hosts, origins)
    if (refusal) return void response.writeHead(403, { "content-type": "text/plain" }).end(refusal)
    const origin = request.headers.origin
    const cors = origin ? corsHeaders(origin, request) : {}
    if (request.method === "OPTIONS") return void response.writeHead(204, cors).end()
    void forward(request, response, engine, input.authorization, cors)
  })
  // The terminal's socket: the same checks, then the upgrade goes to the engine with the credential.
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (refuse(request, hosts, origins)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    const upstream = connect(Number(engine.port || 80), engine.hostname, () => {
      const headers = Object.entries({ ...request.headers, host: engine.host, authorization: input.authorization })
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`))
      upstream.write([`${request.method} ${request.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${input.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Event streams never end on their own; closing waits for nothing but the listener.
        server.closeAllConnections?.()
      }),
  }
}

/** FlupCode's web app, where it is published and where it runs in development. */
export const WEB_ORIGINS = ["https://app.flupcode.com", "http://localhost:4444", "http://127.0.0.1:4444"]

function extraOrigins() {
  return (process.env.FLUPCODE_WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean)
}

/** Why a request is not served, or nothing. */
function refuse(request: IncomingMessage, hosts: Set<string>, origins: Set<string>) {
  if (!hosts.has(request.headers.host ?? "")) return "This engine answers only at its loopback address"
  const origin = request.headers.origin
  const browser = origin !== undefined || request.headers["sec-fetch-site"] !== undefined
  if (browser && (!origin || !origins.has(origin)))
    return "Only FlupCode's web app can use this engine from a browser (FLUPCODE_WEB_ORIGINS adds others)"
  return undefined
}

function corsHeaders(origin: string, request: IncomingMessage): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": String(request.headers["access-control-request-headers"] ?? "*"),
    "access-control-max-age": "600",
    // Chrome asks before a public page (app.flupcode.com) reaches a loopback address.
    ...(request.headers["access-control-request-private-network"] === "true"
      ? { "access-control-allow-private-network": "true" }
      : {}),
    vary: "Origin",
  }
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  engine: URL,
  authorization: string,
  cors: Record<string, string>,
) {
  // A page that goes away (a closed event stream) stops the engine request with it.
  const abort = new AbortController()
  response.on("close", () => abort.abort())
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "host" || name === "origin" || name === "connection") continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  headers.set("authorization", authorization)
  // The body goes on as the engine sent it, so it must not be compressed under a length that no
  // longer holds.
  headers.set("accept-encoding", "identity")
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request)
  const answer = await fetch(new URL(request.url ?? "/", engine), {
    method: request.method,
    headers,
    signal: abort.signal,
    redirect: "manual",
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit).catch(() => undefined)
  if (!answer) {
    if (!response.headersSent) response.writeHead(502, { ...cors, "content-type": "text/plain" })
    return void response.end("The engine is not answering")
  }
  const sent: Record<string, string> = {}
  answer.headers.forEach((value, name) => {
    if (name.startsWith("access-control-") || name === "content-encoding" || name === "content-length") return
    sent[name] = value
  })
  response.writeHead(answer.status, { ...sent, ...cors })
  // Event streams flush as they come: nothing is buffered here.
  response.flushHeaders()
  if (!answer.body) return void response.end()
  try {
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk)
  } catch {
    // The page or the engine went away mid-stream; there is nobody left to tell.
  }
  response.end()
}
