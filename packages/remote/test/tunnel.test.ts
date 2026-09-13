import { afterAll, describe, expect, test } from "bun:test"
import { acceptChannel, connectChannel, createTunnelClient, random, serveTunnel, wirePair } from "../src"

const seen: { authorization: string | null; origin: string | null }[] = []
let sseCancelled = false

const engine = Bun.serve<string | null>({
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url)
    seen.push({ authorization: request.headers.get("authorization"), origin: request.headers.get("origin") })
    if (url.pathname === "/echo")
      return request
        .text()
        .then((body) => Response.json({ method: request.method, body, query: url.search }, { status: 201 }))
    if (url.pathname === "/empty") return new Response(null, { status: 204 })
    if (url.pathname === "/event") {
      let count = 0
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await Bun.sleep(5)
            controller.enqueue(new TextEncoder().encode(`data: ${count++}\n\n`))
          },
          cancel() {
            sseCancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/big") return new Response(new Uint8Array(500_000).fill(7))
    if (url.pathname === "/socket") {
      if (server.upgrade(request, { data: url.searchParams.get("auth_token") })) return
      return new Response("upgrade failed", { status: 400 })
    }
    return new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.send(`token:${ws.data}`)
    },
    message(ws, message) {
      ws.send(typeof message === "string" ? `echo:${message}` : message)
    },
  },
})

afterAll(() => engine.stop(true))

async function setup() {
  const [clientWire, hostWire] = wirePair()
  const psk = random(32)
  const [client, accepted] = await Promise.all([
    connectChannel(clientWire, { mode: "device", id: "d1", psk }),
    acceptChannel(hostWire, () => psk),
  ])
  serveTunnel(accepted.channel, { target: `http://127.0.0.1:${engine.port}`, credentials: btoa("opencode:secret") })
  return createTunnelClient(client)
}

describe("tunnel", () => {
  test("proxies a request with a body, injecting credentials and dropping the origin", async () => {
    const tunnel = await setup()
    const response = await tunnel.fetch("https://remote.invalid/echo?x=1", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "hello",
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ method: "POST", body: "hello", query: "?x=1" })
    expect(seen.at(-1)).toEqual({ authorization: `Basic ${btoa("opencode:secret")}`, origin: null })
  })

  test("handles null-body statuses and large bodies", async () => {
    const tunnel = await setup()
    const empty = await tunnel.fetch("https://remote.invalid/empty")
    expect(empty.status).toBe(204)
    const big = new Uint8Array(await (await tunnel.fetch("https://remote.invalid/big")).arrayBuffer())
    expect(big.byteLength).toBe(500_000)
    expect(big.every((byte) => byte === 7)).toBe(true)
  })

  test("streams server-sent events and aborts them", async () => {
    const tunnel = await setup()
    const abort = new AbortController()
    const response = await tunnel.fetch("https://remote.invalid/event", { signal: abort.signal })
    const reader = response.body!.getReader()
    const chunks: string[] = []
    while (chunks.join("").split("\n\n").length < 4) {
      const chunk = await reader.read()
      chunks.push(new TextDecoder().decode(chunk.value))
    }
    expect(chunks.join("")).toStartWith("data: 0\n\ndata: 1\n\ndata: 2\n\n")
    abort.abort()
    await expect(reader.read()).rejects.toBeDefined()
    await Bun.sleep(50)
    expect(sseCancelled).toBe(true)
  })

  test("rejects paths that escape the engine origin", async () => {
    const tunnel = await setup()
    await expect(tunnel.fetch("https://remote.invalid//evil.example/x")).rejects.toThrow("Invalid path")
  })

  test("tunnels WebSockets with text and binary frames", async () => {
    const tunnel = await setup()
    const socket = tunnel.socket("wss://remote.invalid/socket")
    socket.binaryType = "arraybuffer"
    const messages: (string | number[])[] = []
    const finished = new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send("hi")
        socket.send(new Uint8Array([1, 2, 3]))
      }
      socket.onmessage = (event) => {
        messages.push(
          typeof event.data === "string" ? event.data : Array.from(new Uint8Array(event.data as ArrayBuffer)),
        )
        if (messages.length === 3) resolve()
      }
    })
    await finished
    expect(messages).toEqual([`token:${btoa("opencode:secret")}`, "echo:hi", [1, 2, 3]])
    const closed = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)))
    socket.close()
    expect(await closed).toBe(1000)
    expect(socket.readyState).toBe(3)
  })

  test("fails pending requests when the channel closes", async () => {
    const tunnel = await setup()
    const response = await tunnel.fetch("https://remote.invalid/event")
    const reader = response.body!.getReader()
    await reader.read()
    tunnel.close()
    await expect(reader.read()).rejects.toThrow("Remote connection closed")
    await expect(tunnel.fetch("https://remote.invalid/echo")).rejects.toThrow("Remote connection closed")
  })

  test("delivers control messages", async () => {
    const [clientWire, hostWire] = wirePair()
    const psk = random(32)
    const [client, accepted] = await Promise.all([
      connectChannel(clientWire, { mode: "pair", id: "p", psk }),
      acceptChannel(hostWire, () => psk),
    ])
    const host = serveTunnel(accepted.channel, { target: `http://127.0.0.1:${engine.port}` })
    const tunnel = createTunnelClient(client)
    const received = new Promise((resolve) => tunnel.onControl(resolve))
    host.sendControl({ type: "enrolled", deviceId: "d9" })
    expect(await received).toEqual({ type: "enrolled", deviceId: "d9" })
  })
})
