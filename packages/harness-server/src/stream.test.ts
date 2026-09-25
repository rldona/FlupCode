import { afterEach, describe, expect, test } from "bun:test"
import { createHarnessServer } from "./index"

const input = {
  name: "Nightly",
  description: "",
  prompt: "Check dependencies",
  schedule: { type: "manual" as const },
}

let running: { stop: () => void } | undefined
afterEach(() => {
  running?.stop()
  running = undefined
})

/**
 * A server on its own port, with the scheduler idle: these tests are about the stream.
 *
 * The token is given rather than read, so building a server in a test never writes a secret into the
 * reader's real config directory.
 */
const start = () => {
  const app = createHarnessServer({
    port: 0,
    databasePath: ":memory:",
    intervalMs: 3_600_000,
    browserToken: "stream-test-token",
  })
  running = app
  return app
}

/** Read frames until `enough` of them have arrived, or give up. */
async function read(response: Response, enough: number, timeoutMs = 4000) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Array<{ id?: string; data?: string }> = []
  const deadline = Date.now() + timeoutMs
  let buffer = ""
  try {
    while (frames.length < enough && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ])
      if (next.done || !next.value) break
      buffer += decoder.decode(next.value, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const id = chunk.match(/^id: (\d+)$/m)?.[1]
        const data = chunk.match(/^data: (.*)$/m)?.[1]
        if (data) frames.push({ id, data })
        index = buffer.indexOf("\n\n")
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return frames
}

describe("the server's event stream", () => {
  test("a change reaches a client that is already listening", async () => {
    const app = start()
    const response = await fetch(`${app.server.url}harness/events`)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const frames = read(response, 1)
    app.repository.create(input)
    const received = await frames

    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!.data!).type).toBe("routine.changed")
    // The id is the sequence, which is what the client sends back to say where it got to.
    expect(received[0]!.id).toBe("1")
  })

  // The point of writing events down: a client that was away asks for what it missed instead of
  // refetching everything, and gets it before it starts following along.
  test("a client that was away is given what it missed, and only that", async () => {
    const app = start()
    const routine = app.repository.create(input) // seq 1
    app.repository.setEnabled(routine.id, false) // seq 2
    app.repository.setEnabled(routine.id, true) // seq 3

    const response = await fetch(`${app.server.url}harness/events?after=2`)
    const received = await read(response, 1)
    expect(received.map((frame) => frame.id)).toEqual(["3"])
  })

  test("Last-Event-ID says where it got to, as a browser resends it by itself", async () => {
    const app = start()
    const routine = app.repository.create(input)
    app.repository.setEnabled(routine.id, false)

    const response = await fetch(`${app.server.url}harness/events`, { headers: { "last-event-id": "1" } })
    const received = await read(response, 1)
    expect(received.map((frame) => frame.id)).toEqual(["2"])
  })

  // What went wrong in the app: a client that says nothing has just read the lists, so replaying the
  // log tells it about runs and routines that were deleted long ago. It gets what happens next.
  test("a client that says nothing is told nothing that already happened", async () => {
    const app = start()
    const routine = app.repository.create(input) // seq 1
    app.repository.setEnabled(routine.id, false) // seq 2

    const response = await fetch(`${app.server.url}harness/events`)
    const frames = read(response, 1)
    app.repository.setEnabled(routine.id, true) // seq 3
    const received = await frames

    expect(received.map((frame) => frame.id)).toEqual(["3"])
  })

  test("a run is on the stream whatever asked for it", async () => {
    const app = start()
    const response = await fetch(`${app.server.url}harness/events`)
    const frames = read(response, 2)
    const run = app.repository.startRun({ type: "manual" }, 1000)
    app.repository.finishRun(run.id, "success", undefined, 2000)
    const received = await frames

    expect(received.map((frame) => JSON.parse(frame.data!).type)).toEqual(["run.started", "run.changed"])
    expect(JSON.parse(received[0]!.data!).run.source).toEqual({ type: "manual" })
  })
})
