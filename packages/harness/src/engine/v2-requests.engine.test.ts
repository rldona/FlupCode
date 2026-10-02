import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { createV2Domains } from "./v2"

/**
 * Permissions and forms through the OpenCode 2 adapter against a real 2.x engine (V2-22): what the
 * app's permission and question docks call, answered the ways the docks answer. Runs on the v2 line
 * only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-requests.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  // `bash: ask` is 1.x config; 2.x migrates it to an ask rule on `shell`.
  engine = await startEngine({ modelUrl: model.url, config: { permission: { bash: "ask" } } })
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

describe.skipIf(!run)("permissions on the OpenCode 2 adapter", () => {
  test("a permission is listed in the app's shape, answered once, and the tool runs", async () => {
    const session = await askShell("echo once")
    const request = await pending(() => domains.session.permission.list({ sessionID: session }))
    expect(request).toMatchObject({ sessionID: session, action: "shell", source: { type: "tool" } })
    expect(request.source?.callID).toBeTruthy()
    // Every session's pending requests, which is what marks a session as blocked in the sidebar.
    expect((await domains.permission.pending()).data.map((item) => item.id)).toContain(request.id)

    await domains.session.permission.reply({ sessionID: session, requestID: request.id, reply: "once" })
    await domains.session.wait({ sessionID: session })
    expect(await toolStatus(session)).toBe("completed")
    expect((await domains.session.permission.list({ sessionID: session })).data).toEqual([])
  })

  test("answering always saves a rule the reader can review and revoke", async () => {
    const session = await askShell("echo always")
    const request = await pending(() => domains.session.permission.list({ sessionID: session }))
    await domains.session.permission.reply({ sessionID: session, requestID: request.id, reply: "always" })
    await domains.session.wait({ sessionID: session })
    expect(await toolStatus(session)).toBe("completed")

    const saved = (await domains.permission.saved.list()).data
    const rule = saved.find((item) => item.action === "shell")
    expect(rule).toBeDefined()
    await domains.permission.saved.remove({ id: rule!.id })
    expect((await domains.permission.saved.list()).data.map((item) => item.id)).not.toContain(rule!.id)
  })

  test("a rejection with a message fails the tool and the turn goes on", async () => {
    const session = await askShell("echo reject")
    const request = await pending(() => domains.session.permission.list({ sessionID: session }))
    await domains.session.permission.reply({
      sessionID: session,
      requestID: request.id,
      reply: "reject",
      message: "Use another way",
    })
    await domains.session.wait({ sessionID: session })
    expect(await toolStatus(session)).toBe("error")
  })
})

describe.skipIf(!run)("forms on the OpenCode 2 adapter", () => {
  test("a question reads as the app's question and is answered with a picked option", async () => {
    const session = await askQuestions([
      {
        question: "Pick one",
        header: "Pick",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
    ])
    const request = await pending(() => domains.session.question.list({ sessionID: session }))
    expect(request).toMatchObject({
      sessionID: session,
      questions: [
        {
          question: "Pick one",
          header: "Pick",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
          custom: true,
        },
      ],
      tool: { messageID: expect.any(String), callID: expect.any(String) },
    })
    // Every session's open questions, which is what marks a session as waiting for an answer in
    // the sidebar when it is not the open one (UX-02).
    const listed = (await domains.question.pending()).data.find((item) => item.id === request.id)
    expect(listed).toMatchObject({ sessionID: session, questions: [{ question: "Pick one" }] })

    await domains.session.question.reply({ sessionID: session, requestID: request.id, answers: [["A"]] })
    await domains.session.wait({ sessionID: session })
    expect(await toolAnswers(session)).toEqual([["A"]])
    expect((await domains.question.pending()).data.map((item) => item.id)).not.toContain(request.id)
  })

  test("several picks and a typed answer reach the tool as given", async () => {
    const session = await askQuestions([
      {
        question: "Pick some",
        header: "Some",
        multiple: true,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
      { question: "Anything else?", header: "Else", options: [{ label: "No", description: "nothing" }] },
    ])
    const request = await pending(() => domains.session.question.list({ sessionID: session }))
    expect(request.questions[0]?.multiple).toBe(true)

    await domains.session.question.reply({
      sessionID: session,
      requestID: request.id,
      answers: [["A", "B"], ["Something typed"]],
    })
    await domains.session.wait({ sessionID: session })
    expect(await toolAnswers(session)).toEqual([["A", "B"], ["Something typed"]])
  })

  test("dismissing a question cancels its form", async () => {
    const session = await askQuestions([
      { question: "Pick one", header: "Pick", options: [{ label: "A", description: "first" }] },
    ])
    const request = await pending(() => domains.session.question.list({ sessionID: session }))
    await domains.session.question.reject({ sessionID: session, requestID: request.id })
    await domains.session.wait({ sessionID: session })
    expect((await domains.session.question.list({ sessionID: session })).data).toEqual([])
  })
})

async function askShell(command: string) {
  const session = await domains.session.create({ location: { directory: engine.project } })
  model.push({ type: "tool", name: "shell", input: { command, description: "Run it" } })
  model.push({ type: "text", text: "Done" })
  await domains.session.prompt({ sessionID: session.id, text: "run it" })
  return session.id
}

async function askQuestions(questions: unknown[]) {
  const session = await domains.session.create({ location: { directory: engine.project } })
  model.push({ type: "tool", name: "question", input: { questions } })
  model.push({ type: "text", text: "Thanks" })
  await domains.session.prompt({ sessionID: session.id, text: "ask me" })
  return session.id
}

/** The first request the list holds, once the engine has raised one. */
async function pending<T>(list: () => Promise<{ data: T[] }>) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const first = (await list()).data[0]
    if (first) return first
    if (Date.now() > deadline) throw new Error("No request was raised")
    await Bun.sleep(50)
  }
}

async function tool(sessionID: string) {
  const messages = (await domains.message.list({ sessionID })).data
  const found = messages.flatMap((message) => (message.type === "assistant" ? message.content : []))
  return found.find((item) => item.type === "tool")
}

async function toolStatus(sessionID: string) {
  const found = await tool(sessionID)
  return found?.type === "tool" ? found.state.status : undefined
}

/** What the question tool handed the model, one list of answers per question. */
async function toolAnswers(sessionID: string) {
  const found = await tool(sessionID)
  if (found?.type !== "tool" || found.state.status !== "completed") return undefined
  return (found.state.structured as { answers?: string[][] }).answers
}
