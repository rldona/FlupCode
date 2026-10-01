import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { EngineError } from "./error"
import { createV2Domains } from "./v2"

/**
 * The OpenCode 2 adapter against a real 2.x engine (V2-20): the pinned sandbox binary, isolated, with
 * the stub model from packages/engine-contract. It downloads that binary on first use, so it only
 * runs on the v2 line:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url })
  // The desktop hands the renderer the engine's credentials; here the transport adds them itself.
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
})

beforeEach(() => model.reset())

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the OpenCode 2 adapter", () => {
  test("creates a session in a folder and lists it in the app's shape", async () => {
    const created = await domains.session.create({ location: { directory: engine.project } })
    expect(created).toMatchObject({ title: "", location: { directory: engine.project } })
    const listed = await domains.session.list({ directory: engine.project })
    expect(listed.data.map((session) => session.id)).toContain(created.id)
  })

  test("sends a turn, waits for it, and reads the transcript oldest first without the idle marker", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "text", text: "Hello from the stub" })
    await domains.session.send({ sessionID: session.id, directory: engine.project, text: "hi" })
    await domains.session.wait({ sessionID: session.id })

    const messages = (await domains.message.list({ sessionID: session.id })).data
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
    expect(messages[1]).toMatchObject({
      content: [{ type: "text", id: `${messages[1]!.id}:0`, text: "Hello from the stub" }],
    })
    const newestFirst = (await domains.message.list({ sessionID: session.id, order: "desc" })).data
    expect(newestFirst.map((message) => message.type)).toEqual(["assistant", "user"])
  })

  test("interrupting a running turn ends it with an error on the assistant", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "hang" })
    await domains.session.prompt({ sessionID: session.id, text: "take your time" })
    const deadline = Date.now() + 10_000
    while (!(await domains.session.active()).has(session.id) && Date.now() < deadline) await Bun.sleep(50)
    await domains.session.abort({ sessionID: session.id })
    await domains.session.wait({ sessionID: session.id })

    const assistant = (await domains.message.list({ sessionID: session.id })).data.find(
      (message) => message.type === "assistant",
    )
    expect(assistant).toMatchObject({ error: { type: "unknown" } })
  })

  test("a prompt queued behind a running turn waits in the inbox, where it is steered or cancelled", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "hang" })
    await domains.session.send({ sessionID: session.id, directory: engine.project, text: "take your time" })
    const deadline = Date.now() + 10_000
    while (!(await domains.session.active()).has(session.id) && Date.now() < deadline) await Bun.sleep(50)

    await domains.session.send({
      sessionID: session.id,
      directory: engine.project,
      text: "then this",
      delivery: "queue",
    })
    const queued = await domains.session.inbox.list({ sessionID: session.id })
    expect(queued).toEqual([{ id: expect.any(String), text: "then this", files: [], delivery: "queue" }])
    await domains.session.inbox.cancel({ sessionID: session.id, inboxID: queued[0]!.id })
    expect(await domains.session.inbox.list({ sessionID: session.id })).toEqual([])

    await domains.session.send({
      sessionID: session.id,
      directory: engine.project,
      text: "and this",
      delivery: "queue",
    })
    const [waiting] = await domains.session.inbox.list({ sessionID: session.id })
    await domains.session.inbox.update({ sessionID: session.id, inboxID: waiting!.id, delivery: "steer" })
    // The running provider turn never reaches its boundary, so the steered prompt is still waiting.
    expect((await domains.session.inbox.list({ sessionID: session.id })).map((item) => item.delivery)).toEqual([
      "steer",
    ])

    model.push({ type: "text", text: "Done" })
    await domains.session.abort({ sessionID: session.id })
    await domains.session.wait({ sessionID: session.id })
  })

  test("renames, forks and removes a session", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    await domains.session.rename({ sessionID: session.id, title: "Renamed" })
    const renamed = (await domains.session.list({ directory: engine.project })).data.find(
      (item) => item.id === session.id,
    )
    expect(renamed?.title).toBe("Renamed")

    // 2.x refuses to fork an empty session ("Cannot fork empty session"), so it gets a turn first.
    model.push({ type: "text", text: "Something to fork" })
    await domains.session.prompt({ sessionID: session.id, text: "hi" })
    await domains.session.wait({ sessionID: session.id })
    const fork = await domains.session.fork({ sessionID: session.id })
    expect(fork.id).not.toBe(session.id)

    await domains.session.remove({ sessionID: fork.id })
    const remaining = (await domains.session.list({ directory: engine.project })).data.map((item) => item.id)
    expect(remaining).not.toContain(fork.id)
  })

  test("says what 2.x no longer has instead of failing some other way", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    const refused = await domains.session.share({ sessionID: session.id }).catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(EngineError)
    expect((refused as EngineError).tag).toBe("UnsupportedByEngine")
    expect(await domains.session.todos({ sessionID: session.id })).toEqual({ data: [] })
  })

  test("keeps the engine's error tag for a session that does not exist", async () => {
    const missing = await domains.session
      .rename({ sessionID: "ses_missing", title: "x" })
      .catch((cause: unknown) => cause)
    expect(missing).toBeInstanceOf(EngineError)
    expect((missing as EngineError).tag).toBe("SessionNotFoundError")
  })
})
