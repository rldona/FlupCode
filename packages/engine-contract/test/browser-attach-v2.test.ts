import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
import { startModel } from "../src/model"

/**
 * The engine's built-in `opencode.browser` plugin and its attach protocol (BU-07, ADR-0028). The
 * engine owns the `browser.*` tools; a client that attaches to a session executes them. This probe is
 * that client, reduced to what the protocol needs: it attaches over `experimental.browser` version 4,
 * publishes one tab, answers one snapshot command and checks the answer reaches the model. A pin bump
 * that changes the protocol fails here. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test test/browser-attach-v2.test.ts
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine

beforeAll(async () => {
  if (!run) return
  // The plugin is built in: it loads even in pure mode, with no FlupCode plugin installed.
  engine = await startEngine({ modelUrl: model.url })
}, 120_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the opencode.browser attach protocol on OpenCode 2", () => {
  test("with no client attached, a browser tool answers that the browser is disconnected", async () => {
    const sessionID = await session()
    model.push(
      { type: "tool", name: "execute", input: { code: "return await tools.browser.tabs.list({})" } },
      { type: "text", text: "Done" },
    )
    await call("POST", `/api/session/${sessionID}/prompt`, { text: "list the tabs" })
    await call("POST", `/api/experimental/session/${sessionID}/wait`)
    expect(toolResults()).toContainEqual(expect.stringContaining("[browser.disconnected]"))
  })

  test("an attached client receives the command and its result reaches the model", async () => {
    const stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
    await stream.opened
    const sessionID = await session()
    const connectionID = crypto.randomUUID()
    // `attach` is held open for as long as the client is attached; it answers when it is replaced.
    const attached = rpc("attach", { sessionID, connectionID, version: 4 })
    expect((await stream.until((event) => event.type === "rpc.experimental.browser.control", 10_000)).data).toEqual({
      type: "attached",
      connectionID,
      version: 4,
    })

    const tab = {
      id: `tab_${crypto.randomUUID()}`,
      url: "https://example.test/",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
    }
    await rpc("state", { sessionID, connectionID, state: { tabs: [tab], focusedTabID: tab.id } })
    model.push(
      { type: "tool", name: "execute", input: { code: `return await tools.browser.snapshot({ tabID: "${tab.id}" })` } },
      { type: "text", text: "Done" },
    )
    await call("POST", `/api/session/${sessionID}/prompt`, { text: "read the page" })

    // The event carries only ids; the client fetches the command, runs it and posts the outcome.
    const command = await stream.until(
      (event) => event.type === "rpc.experimental.browser.control" && event.data.type === "command",
      20_000,
    )
    const requestID = String(command.data.requestID)
    expect(command.data).toEqual({ type: "command", connectionID, requestID })
    expect(await rpc("command", { sessionID, connectionID, requestID })).toEqual({
      output: { action: { type: "snapshot", tabID: tab.id }, generation: 0, files: [] },
    })
    const snapshot = '- heading "Contract page" [ref=e1]'
    await rpc("result", {
      sessionID,
      connectionID,
      requestID,
      outcome: { type: "success", result: { value: { tab, content: snapshot, truncated: false }, files: [] } },
    })
    await call("POST", `/api/experimental/session/${sessionID}/wait`)
    expect(toolResults()).toContainEqual(expect.stringContaining("Contract page"))

    // A second client takes the session over; the first one's `attach` ends as replaced.
    void rpc("attach", { sessionID, connectionID: crypto.randomUUID(), version: 4 }).catch(() => undefined)
    expect(await attached).toEqual({ output: "replaced" })
  })

  test("denying the browser permission takes the tools away; ask does not ask", async () => {
    const stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
    await stream.opened
    const outcomes = await Promise.all(
      ["deny", "ask"].map(async (effect) => {
        const sessionID = await session([{ action: "browser", resource: "*", effect }])
        const connectionID = crypto.randomUUID()
        void rpc("attach", { sessionID, connectionID, version: 4 }).catch(() => undefined)
        await stream.until(
          (event) => event.type === "rpc.experimental.browser.control" && event.data.connectionID === connectionID,
          10_000,
        )
        return { sessionID, connectionID }
      }),
    )
    for (const attached of outcomes) {
      model.push(
        { type: "tool", name: "execute", input: { code: "return await tools.browser.tabs.list({})" } },
        { type: "text", text: "Done" },
      )
      await call("POST", `/api/session/${attached.sessionID}/prompt`, { text: "list the tabs" })
      const command = await Promise.race([
        stream.until(
          (event) =>
            event.type === "rpc.experimental.browser.control" &&
            event.data.type === "command" &&
            event.data.connectionID === attached.connectionID,
          10_000,
        ),
        call("POST", `/api/experimental/session/${attached.sessionID}/wait`).then(() => undefined),
      ])
      if (command)
        await rpc("result", {
          ...attached,
          requestID: command.data.requestID,
          outcome: { type: "success", result: { value: { tabs: [], focusedTabID: null }, files: [] } },
        })
      await call("POST", `/api/experimental/session/${attached.sessionID}/wait`)
    }
    const dispatched = stream.events.filter(
      (event) => event.type === "rpc.experimental.browser.control" && event.data.type === "command",
    )
    // `deny` hides the namespace: nothing is dispatched. `ask` runs the command with no permission asked.
    expect(dispatched.map((event) => event.data.connectionID)).toEqual([outcomes[1]?.connectionID])
    expect(stream.events.filter((event) => event.type.startsWith("permission."))).toEqual([])
  })
})

async function session(permissions = [{ action: "*", resource: "*", effect: "allow" }]) {
  const created = (await call("POST", "/api/session", { location: { directory: engine.project }, agent: "build" })) as {
    data: { id: string }
  }
  await call("PATCH", `/api/session/${created.data.id}`, { permissions })
  return created.data.id
}

/** The tool results the model was sent, newest request last. */
function toolResults() {
  return model.requests.flatMap((request) =>
    ((request.messages ?? []) as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content)),
  )
}

async function rpc(method: string, input: unknown) {
  return call("POST", `/api/rpc/experimental.browser/${method}`, { input })
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: { authorization: engine.authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
