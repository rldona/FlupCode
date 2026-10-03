import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as EngineProcess } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { GROUP_TITLE } from "@flupcode/bridge-extension/protocol"
import { createBrowserAttach } from "./browser-attach"
import { launchBridgeBrowser, startBridgeHarness, until } from "./browser-bridge.fixture"
import { createEgressGuard } from "./browser-egress"
import { startFormSite } from "./browser-form.fixture"
import { UNTRUSTED_NOTICE, createBrowserPolicy } from "./browser-policy"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"

/**
 * The agent in the person's own browser (BU-04) end to end on the pinned engine: FlupCode Bridge
 * loaded unpacked into Playwright's Chromium on a throwaway profile, paired with a harness, and that
 * harness attached to the engine's `opencode.browser` plugin over `experimental.browser` v4
 * (ADR-0028) with the bridge as its driver. The stub model calls `tools.browser.*` from Code Mode as a
 * model would. What is proved: the agent completes the three-step form in a tab of the FlupCode group
 * under the browser policy; a tab of the person's outside the group is never listed to it; and when
 * the app closes the debugger lets go and the session loses its tools. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/browser-bridge.engine.test.ts
 */
const { chromium } = await import("playwright")
const run = CONTRACT_LINE === "v2" && existsSync(chromium.executablePath())
const model = startModel()
const site = startFormSite()
const directory = mkdtempSync(join(tmpdir(), "flupcode-bridge-engine-"))
let engine: EngineProcess
let adapter: Engine
let repository: SqliteRoutineRepository
let harness: ReturnType<typeof startBridgeHarness>
let browser: Awaited<ReturnType<typeof launchBridgeBrowser>>

describe.skipIf(!run)("the agent in the person's browser through FlupCode Bridge (BU-04)", () => {
  beforeAll(async () => {
    if (!run) return
    engine = await startEngine({ modelUrl: model.url })
    adapter = new Engine(engine.url, engine.authorization)
    repository = new SqliteRoutineRepository(":memory:")
    harness = startBridgeHarness({
      repository,
      egress: createEgressGuard({ allowLoopbackPorts: [site.port] }),
      dataDir: directory,
    })
    browser = await launchBridgeBrowser()
    await browser.connectTo(harness.port)
    const waiting = await until(
      async () => (await harness.request("GET", "/harness/bridge")).body.data as { waiting: Array<{ id: string }> },
      (value) => value.waiting.length === 1,
    )
    await harness.request("POST", "/harness/bridge/pair", { id: waiting.waiting[0]!.id })
    await until(
      async () => (await harness.request("GET", "/harness/bridge")).body.data as { connected: unknown },
      (value) => value.connected !== null,
    )
  }, 120_000)

  afterAll(async () => {
    await browser?.stop()
    harness?.stop()
    repository?.close()
    await engine?.stop()
    model.stop()
    site.stop()
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  test("the agent completes a form in the FlupCode group, never sees the person's other tab, and loses the browser when the app closes", async () => {
    // The person's own tab, outside the group, on the same site.
    const own = await browser.context.newPage()
    await own.goto(`${site.url}/long`)
    const asked: string[] = []
    const client = createBrowserAttach({
      engine: adapter,
      driver: harness.bridge.driver,
      policy: createBrowserPolicy(repository),
      ask: async (request) => {
        asked.push(`${request.metadata.tier} ${request.metadata.action}`)
        return "session"
      },
    })
    const sessionID = await session()
    await client.attach(sessionID)
    const tab = "const tab = (await tools.browser.tabs.list({})).tabs[0];"
    await turn(
      sessionID,
      `return await tools.browser.tabs.list({})`,
      `const tab = await tools.browser.tabs.open({ url: "${site.url}/" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e2", text: "Ada" }); await tools.browser.click({ tabID: tab.id, ref: "e3" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e3", text: "ada@example.test" }); await tools.browser.click({ tabID: tab.id, ref: "e4" }); await tools.browser.click({ tabID: tab.id, ref: "e5" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e2", text: "pro" }); await tools.browser.press({ tabID: tab.id, key: "Enter" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `return await tools.browser.tabs.list({})`,
    )
    const results = toolResults()
    // Before the agent opened anything, it saw no tab at all: the person's tab is not in the group.
    expect(JSON.parse(results[0]!)).toEqual({ tabs: [], focusedTabID: null })
    const pages = results.slice(1, 5).map((result) => (JSON.parse(result) as { content: string }).content)
    expect(pages[0]).toContain('- textbox "Name" [ref=e2]')
    expect(pages[3]).toContain("name=Ada email=ada@example.test terms=on plan=pro")
    for (const page of pages) expect(page).toStartWith(UNTRUSTED_NOTICE)
    // At the end it still sees only its own tab, never the person's `/long`.
    const last = JSON.parse(results[5]!) as { tabs: Array<{ url: string }> }
    expect(last.tabs.map((entry) => entry.url)).toEqual([`${site.url}/done?name=Ada&email=ada%40example.test&terms=on&plan=pro`])
    expect((await browser.chromeTabs()).find((entry) => entry.url === `${site.url}/long`)?.group).toBeUndefined()
    expect((await browser.chromeTabs()).filter((entry) => entry.group === GROUP_TITLE)).toHaveLength(1)
    // Under the same policy as the agent's own browser: asked to open the site, then to type on it.
    expect(asked).toEqual(["navigate browser.tabs.open", "interact browser.fill"])

    // The app closes: the debugger lets go, and the session is no longer offered the tools.
    expect(await browser.attachedTabs()).toHaveLength(1)
    harness.stop()
    await until(() => browser.attachedTabs(), (value) => value.length === 0)
    await until(() => client.attached(sessionID), (value) => value === false)
    await turn(sessionID, `return await tools.browser.tabs.list({})`)
    expect(toolResults().at(-1)).toContain("Unknown tool 'browser.tabs.list'")
    await client.stop()
  }, 180_000)
})

/** A session under FlupCode's most open mode, so only the browser rule decides the tools. */
async function session() {
  const created = (await call("POST", "/api/session", { location: { directory: engine.project }, agent: "build" })) as {
    data: { id: string }
  }
  await call("PATCH", `/api/session/${created.data.id}`, {
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  return created.data.id
}

/** One prompt in which the model runs each script in turn, then stops. */
async function turn(sessionID: string, ...scripts: string[]) {
  model.push(...scripts.map((code) => ({ type: "tool" as const, name: "execute", input: { code } })), {
    type: "text",
    text: "Done",
  })
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "use my browser" })
  await call("POST", `/api/experimental/session/${sessionID}/wait`)
}

/** What each `execute` returned to the model in the session that ran last, in order. */
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
