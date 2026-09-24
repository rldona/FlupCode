import { afterEach, expect, test } from "bun:test"
import { createClient, isSessionGone, probeServer, subscribeEvents } from "./client"
import { setEngineTransport } from "./transport"

afterEach(() => setEngineTransport(undefined))

/** An event stream that emits what it is given and then stays open without ever closing. */
function stream(frames: string[], onCancel?: () => void) {
  setEngineTransport({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
          },
          cancel: onCancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("a stream that goes quiet is dropped instead of waited on forever", async () => {
  let cancelled = false
  stream([`data: ${JSON.stringify({ type: "server.connected" })}\n\n`], () => {
    cancelled = true
  })

  const seen: string[] = []
  const read = async () => {
    for await (const event of subscribeEvents("http://engine", undefined, "/api/event", 40)) {
      seen.push((event as { type?: string }).type ?? "")
    }
  }

  await expect(read()).rejects.toThrow()
  expect(seen).toEqual(["server.connected"])
  expect(cancelled).toBe(true)
})

test("a stream that keeps beating is not dropped", async () => {
  // Comment frames carry no event, which is exactly what `/api/event` beats with.
  stream([": heartbeat\n\n", `data: ${JSON.stringify({ type: "session.idle" })}\n\n`])

  const seen: string[] = []
  const controller = new AbortController()
  const read = async () => {
    for await (const event of subscribeEvents("http://engine", controller.signal, "/api/event", 40)) {
      seen.push((event as { type?: string }).type ?? "")
      controller.abort()
    }
  }

  await read().catch(() => undefined)
  expect(seen).toEqual(["session.idle"])
})

/** A transport that answers every message read with the same status and body. */
function engine(status: number, body: unknown) {
  setEngineTransport({
    fetch: async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      const payload = /\/message$/.test(url.pathname) ? body : { data: [] }
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("a session the engine no longer has is told apart from an engine that is away", async () => {
  engine(404, { _tag: "SessionNotFoundError", sessionID: "gone", message: "no such session" })
  const missing = await createClient("http://engine").message.list({ sessionID: "gone" }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(isSessionGone(missing)).toBe(true)

  // An engine that is away must not look like a session that is gone: the session stays put and the
  // transcript goes stale instead of being dropped.
  engine(503, { message: "engine away" })
  const away = await createClient("http://engine").message.list({ sessionID: "away" }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(isSessionGone(away)).toBe(false)
})

test("an engine that answers 401 is named as needing authentication, not as stopped", async () => {
  const answer = (status: number) => {
    setEngineTransport({
      fetch: async () => new Response("{}", { status }),
      socket: () => {
        throw new Error("not used")
      },
    })
    return probeServer("http://engine")
  }

  // A password-protected engine is reachable and handing back a refusal; the browser has no way to
  // send credentials, so the fix is neither "start it" nor "allow the origin".
  expect(await answer(401)).toBe("unauthorized")
  expect(await answer(403)).toBe("unauthorized")
  expect(await answer(200)).toBe("online")
})

test("an engine that does not answer at all is offline", async () => {
  setEngineTransport({
    fetch: async () => {
      throw new TypeError("Failed to fetch")
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  expect(await probeServer("http://engine")).toBe("offline")
})

test("saving a credential drops the engine's cached providers, so the new key is the one used", async () => {
  const calls: string[] = []
  setEngineTransport({
    fetch: async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      calls.push(url.pathname)
      return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  const client = createClient("http://engine")
  await client.auth.set({ providerID: "opencode-go", key: "oc_sk_new" })
  await client.auth.reload()

  expect(calls).toEqual(["/auth/opencode-go", "/global/dispose"])
})

/** Records every request, and answers with an empty object the generated calls can unwrap. */
function recordingEngine(calls: Array<{ method: string; path: string }>) {
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      calls.push({ method: request.method.toUpperCase(), path: new URL(request.url).pathname })
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("an MCP server added with the global scope is written to the global configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.add({
    server: "srv",
    config: { type: "remote", url: "https://mcp.example" },
    scope: "global",
  })

  expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/global/config" }])
})

test("an MCP server added with the project scope is written to the directory configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.add({
    server: "srv",
    config: { type: "remote", url: "https://mcp.example" },
    scope: "project",
  })

  expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/config" }])
})

test("updateGlobalConfig writes to the global configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").updateGlobalConfig({ flupcode: { composeTools: [] } })

  expect(calls).toEqual([{ method: "PATCH", path: "/global/config" }])
})

test("removing an MCP server clears it from both configurations and disconnects it", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.remove({ server: "srv" })

  const patches = calls
    .filter((call) => call.method === "PATCH")
    .map((call) => call.path)
    .sort()
  expect(patches).toEqual(["/config", "/global/config"])
  expect(calls.some((call) => call.path.endsWith("/disconnect"))).toBe(true)
})
