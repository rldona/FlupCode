import { afterAll, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { startEngineProxy } from "./engine-proxy"

/** An engine that wants its password, as OpenCode 2 does, with an event stream and a socket. */
const authorization = `Basic ${btoa("opencode:secret")}`
const engine = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, server) => {
    if (request.headers.get("authorization") !== authorization)
      return Response.json({ _tag: "UnauthorizedError" }, { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === "/socket" && server.upgrade(request)) return undefined
    if (url.pathname === "/api/info")
      return Response.json(
        { version: "2.0.18" },
        // The engine's own CORS answer is not what the page sees.
        { headers: { "access-control-allow-origin": "http://elsewhere.example" } },
      )
    if (url.pathname === "/api/echo") return new Response(request.body, { status: 201 })
    if (url.pathname === "/api/event")
      return new Response(
        new ReadableStream({
          start: async (controller) => {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"))
            await Bun.sleep(300)
            controller.enqueue(new TextEncoder().encode("data: second\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    return Response.json({ _tag: "NotFound" }, { status: 404 })
  },
  websocket: {
    message: (socket, message) => {
      socket.send(`echo ${message}`)
    },
  },
})

const port = freePort()
const proxy = await startEngineProxy({ port, engine: engine.url.href, authorization, origins: ["oc://renderer"] })
const base = `http://127.0.0.1:${port}`

afterAll(async () => {
  await proxy.close()
  engine.stop(true)
})

describe("the engine proxy", () => {
  test("signs FlupCode's web app in, and answers its CORS itself", async () => {
    const answer = await fetch(`${base}/api/info`, { headers: { origin: "https://app.flupcode.com" } })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ version: "2.0.18" })
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://app.flupcode.com")

    const preflight = await fetch(`${base}/api/info`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:4444",
        "access-control-request-headers": "content-type",
        "access-control-request-private-network": "true",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type")
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true")
  })

  test("refuses any other page, and a browser request that names no origin", async () => {
    const other = await fetch(`${base}/api/info`, { headers: { origin: "https://evil.example" } })
    expect(other.status).toBe(403)
    const navigated = await fetch(`${base}/api/info`, { headers: { "sec-fetch-site": "cross-site" } })
    expect(navigated.status).toBe(403)
  })

  test("refuses a host that is not its loopback address, which is what a rebound DNS name would send", async () => {
    const status = await new Promise<number>((resolve) => {
      httpRequest(
        { host: "127.0.0.1", port, path: "/api/info", headers: { host: `attacker.example:${port}` } },
        (res) => resolve(res.statusCode ?? 0),
      ).end()
    })
    expect(status).toBe(403)
  })

  test("serves a process on this computer, the desktop's own window and request bodies", async () => {
    expect((await fetch(`${base}/api/info`)).status).toBe(200)
    expect((await fetch(`${base}/api/info`, { headers: { origin: "oc://renderer" } })).status).toBe(200)
    const echoed = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { origin: "https://app.flupcode.com", "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    })
    expect(echoed.status).toBe(201)
    expect(await echoed.json()).toEqual({ text: "hi" })
  })

  test("streams events as they come rather than when the stream ends", async () => {
    const answer = await fetch(`${base}/api/event`, { headers: { origin: "https://app.flupcode.com" } })
    const reader = answer.body!.getReader()
    const started = Date.now()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("first")
    expect(Date.now() - started).toBeLessThan(250)
    await reader.cancel()
  })

  test("carries the terminal's socket through, signed in", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
      headers: { origin: "http://localhost:4444" },
    } as never)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hi")
      socket.onmessage = (event) => resolve(String(event.data))
      socket.onerror = () => reject(new Error("socket failed"))
    })
    expect(reply).toBe("echo hi")
    socket.close()
  })
})

function freePort() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const free = probe.port
  probe.stop(true)
  return free
}
