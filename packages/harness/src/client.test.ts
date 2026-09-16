import { afterEach, expect, test } from "bun:test"
import { subscribeEvents } from "./client"
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
