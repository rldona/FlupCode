import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { startEngine, STUB_MODEL, type Engine } from "../src/engine"
import { recordEvents, type EngineEvent } from "../src/events"
import { keys, matchFixture } from "../src/fixture"
import { startModel } from "../src/model"

/**
 * The engine contract FlupCode depends on (V2-02), exercised the way the harness and harness-server
 * call it today: a session per flow, a turn sent through `prompt_async`, the transcript read from
 * the per-folder `/event` stream and `/session/:id/message`, permissions and questions answered
 * through their registries. Each flow records a fixture, so a different engine (a new 1.x, or 2.x
 * through `FLUPCODE_CONTRACT_ENGINE`) shows exactly which of these shapes moved.
 */

const model = startModel()
let engine: Engine
let stream: ReturnType<typeof recordEvents>

beforeAll(async () => {
  // Shell commands ask first, so the permission flow has something to answer; everything else runs.
  engine = await startEngine({ modelUrl: model.url, config: { permission: { bash: "ask" } } })
  stream = recordEvents(`${engine.url}/event${query()}`, engine.authorization)
  await stream.opened
})

beforeEach(() => model.reset())

afterAll(async () => {
  stream?.close()
  await engine?.stop()
  model.stop()
})

describe("engine contract", () => {
  test("identifies its line and version", () => {
    expect(["v1", "v2"]).toContain(engine.detected.kind)
  })

  test("a text turn streams into the transcript and ends idle", async () => {
    const session = await createSession()
    model.push({ type: "text", text: "Hello from the stub" })
    await prompt(session.id, "hi")
    await idle(session.id)

    const messages = await transcript(session.id)
    expect(messages.at(-1)?.parts.find((part) => part.type === "text")?.text).toBe("Hello from the stub")
    const deltas = sessionEvents(session.id).filter((event) => event.type === "message.part.delta")
    expect(deltas.length).toBeGreaterThan(0)
    matchFixture(engine.detected.kind, "text-turn", {
      events: eventTypes(session.id),
      transcript: shape(messages),
      session: keys(session),
      assistant: keys(messages.at(-1)?.info),
      textPart: keys(messages.at(-1)?.parts.find((part) => part.type === "text")),
    })
  })

  test("a tool call runs and its result lands in the tool part", async () => {
    writeFileSync(join(engine.project, "notes.txt"), "contract notes\n")
    const session = await createSession()
    model.push({ type: "tool", name: "read", input: { filePath: join(engine.project, "notes.txt") } })
    model.push({ type: "text", text: "Read it" })
    await prompt(session.id, "read the notes")
    await idle(session.id)

    const messages = await transcript(session.id)
    const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    expect(String(tool?.state?.output)).toContain("contract notes")
    matchFixture(engine.detected.kind, "tool-turn", {
      events: eventTypes(session.id),
      transcript: shape(messages),
      toolPart: keys(tool),
      toolState: keys(tool?.state),
    })
  })

  test("a permission is asked, listed, answered once, and the tool then runs", async () => {
    const session = await createSession()
    model.push({ type: "tool", name: "bash", input: { command: "echo contract", description: "Say contract" } })
    model.push({ type: "text", text: "Ran it" })
    await prompt(session.id, "run it")
    const asked = await stream.until((event) => event.type === "permission.asked" && belongsTo(session.id)(event))

    const pending = (await get(`/permission${query()}`)) as Array<Record<string, unknown>>
    const request = pending.find((item) => item.sessionID === session.id)
    expect(request?.id).toBe(asked.data.id)
    expect(await post(`/permission/${request?.id}/reply${query()}`, { reply: "once" })).toBe(true)
    await idle(session.id)

    const types = eventTypes(session.id, false)
    expect(types.indexOf("permission.asked")).toBeLessThan(types.indexOf("permission.replied"))
    const messages = await transcript(session.id)
    const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    matchFixture(engine.detected.kind, "permission", {
      events: eventTypes(session.id),
      transcript: shape(messages),
      askedEvent: keys(asked.data),
      request: keys(request),
      requestTool: keys(request?.tool),
    })
  })

  test("a question is asked, answered, and the turn continues", async () => {
    const session = await createSession()
    const questions = [
      {
        question: "Pick one",
        header: "Pick",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
    ]
    model.push({ type: "tool", name: "question", input: { questions } })
    model.push({ type: "text", text: "Picked" })
    await prompt(session.id, "ask me")
    const asked = await stream.until((event) => event.type === "question.asked" && belongsTo(session.id)(event))

    const pending = (await get(`/question${query()}`)) as Array<Record<string, unknown>>
    const request = pending.find((item) => item.sessionID === session.id)
    expect(request?.id).toBe(asked.data.id)
    expect(await post(`/question/${request?.id}/reply${query()}`, { answers: [["A"]] })).toBe(true)
    await idle(session.id)

    const messages = await transcript(session.id)
    const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    matchFixture(engine.detected.kind, "question", {
      events: eventTypes(session.id),
      transcript: shape(messages),
      askedEvent: keys(asked.data),
      request: keys(request),
    })
  })

  test("aborting a running turn ends it idle with an aborted assistant message", async () => {
    const session = await createSession()
    model.push({ type: "hang" })
    await prompt(session.id, "take your time")
    // Aborted once the partial reply has streamed, so the transcript it leaves is always the same.
    await stream.until((event) => event.type === "message.part.delta" && belongsTo(session.id)(event))
    expect(await post(`/session/${session.id}/abort${query()}`, {})).toBe(true)
    await idle(session.id)

    const messages = await transcript(session.id)
    expect(messages.at(-1)?.info.error?.name).toBe("MessageAbortedError")
    matchFixture(engine.detected.kind, "abort", {
      events: eventTypes(session.id),
      transcript: shape(messages),
      error: keys(messages.at(-1)?.info.error),
    })
  })

  test("the routes read outside a turn answer for the folder", async () => {
    const session = await createSession()
    const status = await get(`/session/status${query()}`)
    const mcp = await get(`/mcp${query()}`)
    const config = (await get(`/config${query()}`)) as { model?: string }
    const sessions = (await get(`/api/session`)) as { data?: Array<{ id: string }> }

    expect(config.model).toBe(`${STUB_MODEL.providerID}/${STUB_MODEL.modelID}`)
    expect(sessions.data?.some((item) => item.id === session.id)).toBe(true)
    matchFixture(engine.detected.kind, "reads", {
      status: typeof status,
      mcp: typeof mcp,
      config: ["model", "provider"].filter((key) => key in config),
      sessionList: keys(sessions),
      sessionListItem: keys(sessions.data?.[0]),
    })
  })
})

type Part = { type: string; text?: string; tool?: string; state?: { status?: string; output?: unknown } }
type Message = { info: { role: string; error?: { name?: string } }; parts: Part[] }

function query() {
  return `?directory=${encodeURIComponent(engine.project)}`
}

async function get(path: string) {
  const response = await fetch(`${engine.url}${path}`, { headers: { authorization: engine.authorization } })
  expect(response.status).toBe(200)
  return response.json() as Promise<unknown>
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method: "POST",
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.ok).toBe(true)
  return response.status === 204 ? undefined : (response.json() as Promise<unknown>)
}

async function createSession() {
  return (await post(`/session${query()}`, {})) as { id: string }
}

/** How FlupCode sends every Code and Chat turn (`session.send` in harness/src/client.ts). */
async function prompt(sessionID: string, text: string) {
  await post(`/session/${sessionID}/prompt_async${query()}`, { model: STUB_MODEL, parts: [{ type: "text", text }] })
}

function idle(sessionID: string) {
  return stream.until((event) => event.type === "session.idle" && event.data.sessionID === sessionID)
}

async function transcript(sessionID: string) {
  return (await get(`/session/${sessionID}/message${query()}`)) as Message[]
}

/** Whether an event is about this session, wherever its payload keeps the id. */
function belongsTo(sessionID: string) {
  return (event: EngineEvent) => {
    const data = event.data as {
      sessionID?: string
      info?: { id?: string; sessionID?: string }
      part?: { sessionID?: string }
    }
    return [data.sessionID, data.info?.sessionID, data.info?.id, data.part?.sessionID].includes(sessionID)
  }
}

function sessionEvents(sessionID: string) {
  return stream.events.filter(belongsTo(sessionID))
}

/**
 * The event types a session produced. Sorted and unique for fixtures, because the engine interleaves
 * title generation and snapshots with the turn in no fixed order; in order for assertions.
 */
function eventTypes(sessionID: string, sorted = true) {
  const types = sessionEvents(sessionID).map((event) => event.type)
  return sorted ? [...new Set(types)].sort() : types
}

/** Roles, part types and tool statuses: what the harness renders, without ids or timestamps. */
function shape(messages: Message[]) {
  return messages.map((message) => ({
    role: message.info.role,
    ...(message.info.error ? { error: message.info.error.name } : {}),
    parts: message.parts.map((part) => (part.type === "tool" ? `tool:${part.tool}:${part.state?.status}` : part.type)),
  }))
}
