import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents, type EngineEvent } from "../src/events"
import { keys, matchFixture } from "../src/fixture"
import { startModel } from "../src/model"

/**
 * The same flows as `contract.test.ts`, driven through OpenCode 2's API (V2-06): `/api/session`,
 * `/api/session/:id/prompt`, the global `/api/event` stream, permissions and forms per session.
 * It runs only on the v2 line (`FLUPCODE_CONTRACT_LINE=v2`), against the pinned sandbox binary, and
 * records `fixtures/v2/`. Side by side with `fixtures/v1/`, that is what FlupCode's V2 adapter
 * (V2-20 onwards) has to absorb. Two more tests pin down what FlupCode meets on V2 today: its legacy
 * routes answer the web UI's HTML, and its 1.x plugins are all refused.
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let stream: ReturnType<typeof recordEvents>

beforeAll(async () => {
  if (!run) return
  // `bash: ask` is 1.x config; 2.x migrates it to an ask rule on `shell`.
  engine = await startEngine({ modelUrl: model.url, config: { permission: { bash: "ask" } } })
  stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
  await stream.opened
})

beforeEach(() => model.reset())

afterAll(async () => {
  stream?.close()
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("engine contract on OpenCode 2", () => {
  test("identifies itself as 2.x", () => {
    expect(engine.detected.kind).toBe("v2")
  })

  test("a text turn is admitted, runs, and ends with an idle outcome", async () => {
    const id = await createSession()
    model.push({ type: "text", text: "Hello from the stub" })
    const admitted = (await call("POST", `/api/session/${id}/prompt`, { text: "hi" })) as { data: unknown }
    expect(await finished(id)).toBe("session.execution.succeeded")

    const messages = await transcript(id)
    const assistant = messages.find((message) => message.type === "assistant")
    expect(assistant?.content?.find((item) => item.type === "text")?.text).toBe("Hello from the stub")
    expect(messages.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
    matchFixture(engine.detected.kind, "text-turn", {
      events: eventTypes(id),
      transcript: shape(messages),
      admitted: keys(admitted.data),
      assistant: keys(assistant),
    })
  })

  test("a tool call runs and its result lands in the assistant's content", async () => {
    writeFileSync(join(engine.project, "notes.txt"), "contract notes\n")
    const id = await createSession()
    model.push({ type: "tool", name: "read", input: { path: join(engine.project, "notes.txt") } })
    model.push({ type: "text", text: "Read it" })
    await call("POST", `/api/session/${id}/prompt`, { text: "read the notes" })
    expect(await finished(id)).toBe("session.execution.succeeded")

    const tool = (await transcript(id)).flatMap((message) => message.content ?? []).find((item) => item.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    expect(JSON.stringify(tool?.state)).toContain("contract notes")
    matchFixture(engine.detected.kind, "tool-turn", {
      events: eventTypes(id),
      transcript: shape(await transcript(id)),
      tool: keys(tool),
      toolState: keys(tool?.state),
    })
  })

  test("a permission is asked, listed for the session, answered once, and the tool then runs", async () => {
    const id = await createSession()
    model.push({ type: "tool", name: "shell", input: { command: "echo contract", description: "Say contract" } })
    model.push({ type: "text", text: "Ran it" })
    await call("POST", `/api/session/${id}/prompt`, { text: "run it" })
    const asked = await stream.until((event) => event.type === "permission.asked" && event.data.sessionID === id)

    const pending = ((await call("GET", `/api/session/${id}/permission`)) as { data: Array<{ id: string }> }).data
    expect(pending.map((request) => request.id)).toContain(String(asked.data.id))
    await call("POST", `/api/session/${id}/permission/${asked.data.id}/reply`, { decision: "once" })
    expect(await finished(id)).toBe("session.execution.succeeded")

    const tool = (await transcript(id)).flatMap((message) => message.content ?? []).find((item) => item.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    matchFixture(engine.detected.kind, "permission", {
      events: eventTypes(id),
      transcript: shape(await transcript(id)),
      askedEvent: keys(asked.data),
      request: keys(pending[0]),
    })
  })

  test("a question becomes a form, is answered, and the turn continues", async () => {
    const id = await createSession()
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
    await call("POST", `/api/session/${id}/prompt`, { text: "ask me" })
    const created = await stream.until(
      (event) => event.type === "form.created" && (event.data.form as { sessionID?: string })?.sessionID === id,
    )
    const form = created.data.form as { id: string; fields: Array<{ key: string }> }

    const pending = ((await call("GET", `/api/session/${id}/form`)) as { data: Array<{ id: string }> }).data
    expect(pending.map((item) => item.id)).toContain(form.id)
    await call("POST", `/api/session/${id}/form/${form.id}/reply`, { answer: { [form.fields[0]!.key]: "A" } })
    expect(await finished(id)).toBe("session.execution.succeeded")

    matchFixture(engine.detected.kind, "question", {
      events: eventTypes(id),
      transcript: shape(await transcript(id)),
      form: keys(form),
      field: keys(form.fields[0]),
    })
  })

  test("interrupting a running turn ends it with an interrupted outcome", async () => {
    const id = await createSession()
    model.push({ type: "hang" })
    await call("POST", `/api/session/${id}/prompt`, { text: "take your time" })
    await stream.until((event) => event.type === "session.text.delta" && event.data.sessionID === id)
    expect(await call("POST", `/api/session/${id}/interrupt`, {})).toEqual({ interrupted: true })
    expect(await finished(id)).toBe("session.execution.interrupted")

    const messages = await transcript(id)
    expect(messages.at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    matchFixture(engine.detected.kind, "abort", {
      events: eventTypes(id),
      transcript: shape(messages),
      error: keys(messages.find((message) => message.type === "assistant")?.error),
    })
  })

  test("the routes read outside a turn answer for the location", async () => {
    const id = await createSession()
    const mcp = (await call("GET", "/api/mcp")) as { location?: unknown; data?: unknown }
    const config = (await call("GET", "/api/config")) as Array<{ type?: string }>
    const sessions = (await call("GET", "/api/session")) as { data?: Array<{ id: string }> }
    const agents = (await call("GET", "/api/agent")) as { data?: unknown[] }

    expect(sessions.data?.some((item) => item.id === id)).toBe(true)
    matchFixture(engine.detected.kind, "reads", {
      mcp: keys(mcp),
      configEntryTypes: [...new Set(config.map((entry) => entry.type))].sort(),
      sessionList: keys(sessions),
      sessionListItem: keys(sessions.data?.[0]),
      agents: keys(agents),
    })
  })

  test("the 1.x routes FlupCode calls answer the web UI or refuse the method", async () => {
    const legacy = [
      ["GET", "/global/health"],
      ["GET", "/event"],
      ["GET", "/session/status"],
      ["GET", "/mcp"],
      ["GET", "/config"],
      ["GET", "/permission"],
      ["POST", "/session"],
      ["POST", "/session/ses_contract/prompt_async"],
      ["POST", "/config/reload"],
    ] as const
    const answers = Object.fromEntries(
      await Promise.all(
        legacy.map(async ([method, path]) => {
          const response = await fetch(`${engine.url}${path}`, {
            method,
            headers: headers(),
            body: method === "GET" ? undefined : "{}",
          })
          void response.body?.cancel()
          return [
            `${method} ${path}`,
            `${response.status} ${(response.headers.get("content-type") ?? "").split(";")[0]}`.trim(),
          ]
        }),
      ),
    )
    // None of them is a JSON error FlupCode could read: a GET gets the HTML page with a 200.
    expect(Object.values(answers).every((answer) => answer === "200 text/html" || answer === "405")).toBe(true)
    matchFixture(engine.detected.kind, "legacy-routes", answers)
  })
})

describe.skipIf(!run)("FlupCode's 1.x engine plugins on OpenCode 2", () => {
  test("are discovered and every one of them fails to load", async () => {
    const plugins = startModel()
    const withPlugins = await startEngine({
      modelUrl: plugins.url,
      env: { OPENCODE_PURE: undefined },
      prepare: async (home) => {
        await installEnginePlugins(join(home, ".config", "opencode"))
      },
    })
    try {
      const list = async () =>
        (
          (await (await fetch(`${withPlugins.url}/api/plugin`, { headers: headers(withPlugins) })).json()) as {
            data: Array<{ source?: { type?: string; path?: string }; state?: { status?: string; error?: string } }>
          }
        ).data.filter((plugin) => plugin.source?.path?.includes("/plugins/flupcode-"))
      // Local plugins activate once the location has booted, a moment after its first request.
      const deadline = Date.now() + 20_000
      let ours = await list()
      while (ours.length < 14 && Date.now() < deadline) {
        await Bun.sleep(250)
        ours = await list()
      }
      expect(ours).toHaveLength(14)
      expect(ours.every((plugin) => plugin.state?.status === "failed")).toBe(true)
      matchFixture(
        withPlugins.detected.kind,
        "plugins",
        Object.fromEntries(
          ours
            .map((plugin) => [plugin.source!.path!.split("/").at(-1)!, firstLine(plugin.state?.error)])
            .sort(([a], [b]) => (a! < b! ? -1 : 1)),
        ),
      )
    } finally {
      await withPlugins.stop()
      plugins.stop()
    }
  }, 60_000)
})

type Content = { type: string; text?: string; state?: { status?: string } }
type Message = { type: string; outcome?: string; content?: Content[]; error?: unknown }

function headers(target: Engine = engine) {
  return {
    authorization: target.authorization,
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(target.project),
  }
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return response.status === 204 ? undefined : (response.json() as Promise<unknown>)
}

async function createSession() {
  return ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id
}

async function finished(sessionID: string) {
  const ended = await stream.until(
    (event) =>
      event.type.startsWith("session.execution.") &&
      event.type !== "session.execution.started" &&
      event.data.sessionID === sessionID,
  )
  return ended.type
}

/** Oldest first: the API pages newest first. */
async function transcript(sessionID: string) {
  return ((await call("GET", `/api/session/${sessionID}/message`)) as { data: Message[] }).data.reverse()
}

function belongsTo(sessionID: string) {
  return (event: EngineEvent) => {
    const data = event.data as { sessionID?: string; form?: { sessionID?: string }; info?: { id?: string } }
    return [data.sessionID, data.form?.sessionID, data.info?.id].includes(sessionID)
  }
}

/** Sorted and unique, for the same reason as the 1.x suite: titles and usage interleave freely. */
function eventTypes(sessionID: string) {
  return [...new Set(stream.events.filter(belongsTo(sessionID)).map((event) => event.type))].sort()
}

/** Message kinds, content types and tool statuses, and the idle outcome. */
function shape(messages: Message[]) {
  return messages.map((message) => ({
    type: message.type,
    ...(message.outcome ? { outcome: message.outcome } : {}),
    ...(message.error ? { error: true } : {}),
    ...(message.content
      ? { content: message.content.map((item) => (item.type === "tool" ? `tool:${item.state?.status}` : item.type)) }
      : {}),
  }))
}

/** A plugin error without the stack and the machine's paths. */
function firstLine(error: string | undefined) {
  return (error ?? "")
    .split("\n")[0]!
    .replace(/\(\/[^)]*\)/g, "")
    .trim()
}
