import { afterEach, expect, test } from "bun:test"
import { createClient, isSessionGone, subscribeEvents } from "./client"
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
