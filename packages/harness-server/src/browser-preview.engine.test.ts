import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as EngineProcess } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createBrowserAttach } from "./browser-attach"
import { UNTRUSTED_NOTICE, createBrowserPolicy } from "./browser-policy"
import { createPreview } from "./browser-preview"
import { fakeDesktop } from "./browser-preview.fixture"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"

/**
 * The desktop preview handed to the agent (BU-06), on the pinned engine: the attach client of BU-05
 * with the preview as its driver. The desktop is the fixture's stand-in for main's view (the real
 * one needs Electron); the engine, its `tools.browser.*`, the attach protocol, the policy and the
 * driver are real. What is proved: the agent reads the dev server's page in the preview, labelled
 * untrusted; and a site off this machine asks first, and with the reader saying no the preview never
 * goes there. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/browser-preview.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const directory = mkdtempSync(join(tmpdir(), "flupcode-preview-attach-"))
let engine: EngineProcess
let repository: SqliteRoutineRepository
let adapter: Engine

describe.skipIf(!run)("the preview handed to the agent (BU-06)", () => {
  beforeAll(async () => {
    if (!run) return
    engine = await startEngine({ modelUrl: model.url })
    adapter = new Engine(engine.url, engine.authorization)
    repository = new SqliteRoutineRepository(":memory:")
  }, 120_000)

  afterAll(async () => {
    repository?.close()
    await engine?.stop()
    model.stop()
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  test("the agent reads the page in the preview, and a site off this machine asks first", async () => {
    const preview = createPreview({ repository, dataDir: directory })
    const desktop = fakeDesktop()
    desktop.attach(preview)
    const asked: Array<{ tier: string; action: string; site: string }> = []
    const client = createBrowserAttach({
      engine: adapter,
      driver: preview.driver,
      place: "FlupCode's preview in the desktop app",
      policy: createBrowserPolicy(repository),
      ask: async (request) => {
        asked.push({ tier: request.metadata.tier, action: request.metadata.action, site: request.metadata.site })
        return request.metadata.tier === "read" ? "session" : "deny"
      },
    })
    const sessionID = await session()
    await client.attach(sessionID)
    expect(client.attached(sessionID)).toBe(true)

    await turn(
      sessionID,
      `const tab = (await tools.browser.tabs.list({})).tabs[0]; return await tools.browser.snapshot({ tabID: tab.id })`,
      `const tab = (await tools.browser.tabs.list({})).tabs[0]; try { await tools.browser.navigate({ tabID: tab.id, url: "http://93.184.215.14/" }); return "went" } catch (error) { return String(error && error.message || error) }`,
    )
    const [page, away] = toolResults()
    const content = (JSON.parse(page!) as { content: string; tab: { id: string; url: string } })
    expect(content.tab).toMatchObject({ url: "http://localhost:5173/" })
    expect(content.content).toStartWith(UNTRUSTED_NOTICE)
    expect(content.content).toContain('- textbox "Email" [ref=e2]')
    expect(away).toContain("[browser.denied] The person did not allow the agent to open and read pages on 93.184.215.14")
    expect(asked).toEqual([
      { tier: "read", action: "browser.snapshot", site: "localhost:5173" },
      { tier: "navigate", action: "browser.navigate", site: "93.184.215.14" },
    ])
    // Asked, refused, and main was never told to go there.
    expect(desktop.page.url).toBe("http://localhost:5173/")
    expect(desktop.commands.filter((entry) => entry.method === "navigate" || entry.method === "allow")).toEqual([])

    // Taking the preview back takes the tools with it.
    await client.detach(sessionID)
    expect(client.attached(sessionID)).toBe(false)
    await client.stop()
  }, 120_000)
})

async function session() {
  const created = (await call("POST", "/api/session", { location: { directory: engine.project }, agent: "build" })) as {
    data: { id: string }
  }
  await call("PATCH", `/api/session/${created.data.id}`, {
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  return created.data.id
}

async function turn(sessionID: string, ...scripts: string[]) {
  model.push(...scripts.map((code) => ({ type: "tool" as const, name: "execute", input: { code } })), {
    type: "text",
    text: "Done",
  })
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "use the preview" })
  await call("POST", `/api/experimental/session/${sessionID}/wait`)
}

function toolResults() {
  return ((model.requests.at(-1)?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
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
