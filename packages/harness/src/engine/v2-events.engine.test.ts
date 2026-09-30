import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import type { SessionMessageInfo } from "../engine-types"
import { subscribeEvents } from "../event-stream"
import { setEngineTransport } from "../transport"
import { createV2Domains } from "./v2"
import { createV2Transcript } from "./v2-events"

/**
 * The V2 event reducer against a real 2.x engine (V2-21): a transcript built only from the events
 * of `/api/event`, read the way the app reads them, must equal the one the engine hands back once
 * the turn is over. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-events.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const controller = new AbortController()
const events: Array<{ type?: string; data?: { sessionID?: string } }> = []
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url })
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  domains = createV2Domains(engine.url)
  const connected = Promise.withResolvers<void>()
  void (async () => {
    for await (const event of subscribeEvents(engine.url, controller.signal)) {
      if (event.type === "server.connected") connected.resolve()
      events.push(event)
    }
  })().catch(() => undefined)
  await connected.promise
})

beforeEach(() => model.reset())

afterAll(async () => {
  controller.abort()
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the OpenCode 2 event reducer", () => {
  test("a text turn streams into the transcript the engine records", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "text", text: "Hello from the stub" })
    await turn(session.id, "hi")
    const live = await replay(session.id, [])
    expect(live).toEqual(await engineTranscript(session.id))
    expect(live.map((message) => message.type)).toEqual(["user", "assistant"])
  })

  test("a tool call and its result stream into the transcript the engine records", async () => {
    writeFileSync(join(engine.project, "notes.txt"), "reducer notes\n")
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "tool", name: "read", input: { path: join(engine.project, "notes.txt") } })
    model.push({ type: "text", text: "Read it" })
    await turn(session.id, "read the notes")
    const live = await replay(session.id, [])
    expect(live).toEqual(await engineTranscript(session.id))
    expect(JSON.stringify(live)).toContain("reducer notes")
  })

  test("a second turn lands on top of the transcript read after the first", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "text", text: "First" })
    await turn(session.id, "one")
    const before = await engineTranscript(session.id)
    const from = events.length
    model.push({ type: "text", text: "Second" })
    await turn(session.id, "two")
    expect(await replay(session.id, before, from)).toEqual(await engineTranscript(session.id))
  })

  test("an interrupted turn ends with the same error the engine records", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "hang" })
    await domains.session.prompt({ sessionID: session.id, text: "take your time" })
    await until(session.id, "session.step.started")
    await domains.session.abort({ sessionID: session.id })
    await domains.session.wait({ sessionID: session.id })
    await until(session.id, "session.execution.interrupted")
    expect(await replay(session.id, [])).toEqual(await engineTranscript(session.id))
  })
})

// Needs no engine, so it runs on every line.
test("a delta for a message the stream never saw start asks for one refetch", () => {
  const reducer = createV2Transcript()
  const delta = {
    type: "session.text.delta",
    data: { sessionID: "ses_x", assistantMessageID: "msg_x", ordinal: 0, delta: "hi" },
  }
  expect(reducer.reduce(delta)).toEqual({ sessionID: "ses_x", chars: 0, stale: true })
  expect(reducer.reduce(delta)).toEqual({ sessionID: "ses_x", chars: 0 })
})

async function turn(sessionID: string, text: string) {
  const from = events.length
  await domains.session.send({ sessionID, directory: engine.project, text })
  await domains.session.wait({ sessionID })
  await until(sessionID, "session.execution.succeeded", from)
}

/** The session's events from `from` on, folded over `start` the way the app applies them. */
async function replay(sessionID: string, start: SessionMessageInfo[], from = 0) {
  const reducer = createV2Transcript()
  return events.slice(from).reduce((data, event) => {
    if (event.data?.sessionID !== sessionID) return data
    const change = reducer.reduce(event)
    expect(change?.stale).toBeUndefined()
    return change?.apply ? change.apply(data) : data
  }, start)
}

async function engineTranscript(sessionID: string) {
  return (await domains.message.list({ sessionID })).data
}

/** Waits for the session's first `type` event at or after `from`. */
async function until(sessionID: string, type: string, from = 0) {
  const deadline = Date.now() + 30_000
  while (!events.slice(from).some((event) => event.type === type && event.data?.sessionID === sessionID)) {
    if (Date.now() > deadline) throw new Error(`No ${type} for ${sessionID}`)
    await Bun.sleep(20)
  }
}
