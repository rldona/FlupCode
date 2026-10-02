import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as EngineProcess } from "@flupcode/engine-contract/engine"
import { mcpBrowserCommand } from "@flupcode/engine-contract/mcp-browser"
import { startModel } from "@flupcode/engine-contract/model"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { createHarnessHandler } from "./api"
import { createBrowserMcpGate } from "./browser-mcp"
import { createBrowserPolicy } from "./browser-policy"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * The user's browser through an MCP preset (BU-02), end to end on the pinned engine: FlupCode's
 * plugins, harness-server's real route, policy and approval form, and a stand-in for Playwright MCP
 * in extension mode that offers its tools under their real names and answers in its format. The
 * model calls them from Code Mode as it would on a real tab. What is proved: listing the tabs needs
 * no approval; the first action on a site asks, in the session, before the browser is touched; an
 * answer for the session covers that tier there; a new site asks again; a refusal and a blocked site
 * never reach the browser. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/browser-mcp.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: EngineProcess
let repository: SqliteRoutineRepository
let server: ReturnType<typeof Bun.serve>
// Where the stand-in writes each call that reached it.
const log = join(tmpdir(), `fc-browser-mcp-${process.pid}-${Date.now()}.log`)
let sessionID = ""

type Message = { type: string; finish?: string; time: { created: number } }
type Form = { id: string; metadata?: Record<string, unknown> }

beforeAll(async () => {
  if (!run) return
  repository = new SqliteRoutineRepository(":memory:")
  const policy = createBrowserPolicy(repository)
  let ask: (request: Parameters<Engine["askChoice"]>[0]) => Promise<string | undefined> = async () => undefined
  const handler = (scheduler: RoutineScheduler) =>
    createHarnessHandler(repository, scheduler, {
      token: "ui-token",
      pluginToken: "plugin-token",
      browserMcp: createBrowserMcpGate({ policy, ask: (request) => ask(request) }),
    })
  let serve: ReturnType<typeof handler> | undefined
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => serve!(request) })
  engine = await startEngine({
    modelUrl: model.url,
    env: {
      OPENCODE_PURE: undefined,
      FLUPCODE_HARNESS_SERVER_URL: `http://127.0.0.1:${server.port}`,
      FLUPCODE_PLUGIN_TOKEN: "plugin-token",
    },
    prepare: async (home) => {
      await installEnginePlugins(join(home, ".config", "opencode"))
      // The memory plugin's extraction asks the model after a turn, which would take a scripted reply.
      writeFileSync(join(home, "..", "project", "opencode.json"), JSON.stringify({ memory: { auto: false } }))
    },
    config: {
      mcp: {
        playwright: {
          type: "local",
          command: mcpBrowserCommand(),
          environment: { FAKE_BROWSER_LOG: log },
        },
      },
    },
  })
  const adapter = new Engine(engine.url, engine.authorization)
  ask = (request) => adapter.askChoice(request)
  serve = handler(new RoutineScheduler({ repository, engineURL: engine.url, authorization: engine.authorization }))

  await until(
    async () =>
      ((await call("GET", "/api/mcp")) as { data: Array<{ status: { status: string } }> }).data[0]?.status.status ===
      "connected",
  )
  sessionID = (
    (await call("POST", "/api/session", { location: { directory: engine.project }, agent: "build" })) as {
      data: { id: string }
    }
  ).data.id
  // FlupCode's permission modes: the engine allows everything, and FlupCode's approvals still ask.
  await call("PATCH", `/api/session/${sessionID}`, { permissions: [{ action: "*", resource: "*", effect: "allow" }] })
  // A connected server joins Code Mode's catalog when a turn next builds it.
  model.push({ type: "text", text: "Ready" })
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "ready?" })
  await call("POST", `/api/experimental/session/${sessionID}/wait`)
}, 180_000)

afterAll(async () => {
  server?.stop(true)
  repository?.close()
  await engine?.stop()
  model.stop()
  rmSync(log, { force: true })
})

describe.skipIf(!run)("the user's browser through Playwright MCP on OpenCode 2", () => {
  test("the first action on each site asks before the browser is touched, and a session answer covers the site", async () => {
    // The agent finds the tab it was handed, reads it and clicks in it.
    const first = turn(
      [
        "const tabs = await tools.playwright.browser_tabs({ action: 'list' })",
        "const page = await tools.playwright.browser_snapshot({})",
        "const click = await tools.playwright.browser_click({ element: 'Go', ref: 'e1' })",
        "return [tabs, page, click].join('\\n')",
      ].join("\n"),
    )
    // Listing the tabs asked nothing; reading the page asks, and nothing has read it yet.
    const read = await nextForm()
    expect(read.metadata).toMatchObject({
      flupcode: "browser-approval",
      browser: "yours",
      origin: "https://handed.example",
      site: "handed.example",
      tier: "read",
      action: "playwright.browser_snapshot",
    })
    expect(calls().map((entry) => entry.name)).toEqual(["browser_tabs"])
    await reply(read, "session")
    // Clicking is more than reading: it asks again, on the same site.
    const click = await nextForm()
    expect(click.metadata).toMatchObject({
      origin: "https://handed.example",
      tier: "interact",
      action: "playwright.browser_click",
    })
    expect(calls().map((entry) => entry.name)).toEqual(["browser_tabs", "browser_snapshot"])
    await reply(click, "session")
    await first
    expect(calls().map((entry) => entry.name)).toEqual(["browser_tabs", "browser_snapshot", "browser_click"])

    // The same site again in this session: nothing asks.
    await turn(
      "await tools.playwright.browser_snapshot({}); return await tools.playwright.browser_click({ element: 'Go', ref: 'e1' })",
    )
    expect(await forms()).toEqual([])
    expect(
      calls()
        .map((entry) => entry.name)
        .slice(3),
    ).toEqual(["browser_snapshot", "browser_click"])

    // A new site asks first, and its answer is about that site.
    const elsewhere = turn("return await tools.playwright.browser_navigate({ url: 'https://other.example/start' })")
    const navigate = await nextForm()
    expect(navigate.metadata).toMatchObject({
      origin: "https://other.example",
      tier: "navigate",
      action: "playwright.browser_navigate",
    })
    expect(calls()).toHaveLength(5)
    await reply(navigate, "once")
    await elsewhere
    expect(calls().at(-1)).toMatchObject({ name: "browser_navigate", args: { url: "https://other.example/start" } })

    // The page is now on the new site, which the session has not been granted for clicking.
    const unanswered = turn(
      "return await tools.playwright.browser_click({ element: 'Go', ref: 'e1' }).catch((error) => 'refused: ' + error.message)",
    )
    const refused = await nextForm()
    expect(refused.metadata).toMatchObject({ origin: "https://other.example", tier: "interact" })
    await reply(refused, "deny")
    await unanswered
    expect(calls()).toHaveLength(6)
    // 2.0.18 tells a Code Mode script only that the call failed, not the reason the hook gave.
    expect(lastOutput()).toContain("refused: Unable to execute playwright_browser_click")

    // Every decision, answer and action is in the audit, with the session.
    const audit = repository.listBrowserAudit({ sessionID, limit: 100 })
    expect(
      audit
        .filter((entry) => entry.kind === "answer")
        .map((entry) => [entry.origin, entry.tier, entry.scope ?? entry.decision]),
    ).toEqual(
      expect.arrayContaining([
        ["https://handed.example", "read", "session"],
        ["https://handed.example", "interact", "session"],
        ["https://other.example", "navigate", "once"],
        ["https://other.example", "interact", "deny"],
      ]),
    )
    expect(audit.filter((entry) => entry.kind === "action")).toHaveLength(6)
  }, 120_000)

  test("a blocked site is refused without asking and never reached", async () => {
    const before = calls().length
    await turn(
      "return await tools.playwright.browser_navigate({ url: 'https://accounts.google.com/' }).catch((error) => 'refused: ' + error.message)",
    )
    expect(await forms()).toEqual([])
    expect(calls()).toHaveLength(before)
    expect(lastOutput()).toContain("refused: Unable to execute playwright_browser_navigate")
    expect(
      repository
        .listBrowserAudit({ sessionID, limit: 100 })
        .find((entry) => entry.origin === "https://accounts.google.com"),
    ).toMatchObject({
      kind: "decision",
      decision: "deny",
    })
  }, 60_000)
})

/** One turn in which the model runs `code` in Code Mode; resolves when the turn is over. */
async function turn(code: string) {
  const asked = Date.now()
  model.push({ type: "tool", name: "execute", input: { code } }, { type: "text", text: "Done" })
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "use the browser" })
  // The wait can return while the turn waits on an approval form, so the turn is over when its
  // closing reply is there.
  await until(async () => {
    await call("POST", `/api/experimental/session/${sessionID}/wait`)
    const messages = ((await call("GET", `/api/session/${sessionID}/message`)) as { data: Message[] }).data
    return messages.some(
      (message) => message.type === "assistant" && message.finish === "stop" && message.time.created >= asked,
    )
  })
}

const calls = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> })
    : []

const forms = async () => ((await call("GET", `/api/session/${sessionID}/form`)) as { data: Form[] }).data

async function nextForm() {
  return await until(async () => (await forms())[0])
}

async function reply(form: Form, choice: string) {
  await call("POST", `/api/session/${sessionID}/form/${form.id}/reply`, { answer: { choice } })
  await until(async () => !(await forms()).some((entry) => entry.id === form.id))
}

/** What the last execute call returned to the model. */
function lastOutput() {
  return JSON.stringify(model.requests.at(-1))
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

async function until<T>(read: () => Promise<T>) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error("Never happened")
    await Bun.sleep(100)
  }
}
