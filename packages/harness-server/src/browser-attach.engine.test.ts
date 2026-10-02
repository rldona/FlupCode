import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as EngineProcess } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createRecipeDriver, type RecipeDriver } from "./browser"
import { createBrowserAttach, type BrowserAttach } from "./browser-attach"
import { createEgressGuard } from "./browser-egress"
import { startFormSite } from "./browser-form.fixture"
import { UNTRUSTED_NOTICE, createBrowserPolicy } from "./browser-policy"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"

/**
 * The agent's own browser (BU-05) end to end on the pinned engine: harness-server attached to the
 * engine's `opencode.browser` plugin over `experimental.browser` v4 (ADR-0028), on the recipe
 * runner's Chromium, under the browser policy. The stub model calls `tools.browser.*` from Code Mode
 * as a model would. What is proved: a three-step form is completed by refs alone; the page text the
 * model reads says it is untrusted; every action that touches a page goes through `decide`, and with
 * the reader saying no none of them reaches the site, each refusal reaching the model with its
 * reason; an approval nobody answers in time tells the model to call again; and a session whose
 * browser is gone is no longer offered the tools. Runs on the v2 line only, with Chromium:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/browser-attach.engine.test.ts
 */
const { chromium } = await import("playwright")
const run = CONTRACT_LINE === "v2" && existsSync(chromium.executablePath())
const model = startModel()
const site = startFormSite()
const directory = mkdtempSync(join(tmpdir(), "flupcode-attach-"))
let engine: EngineProcess
let repository: SqliteRoutineRepository
let driver: RecipeDriver
let adapter: Engine
const clients: BrowserAttach[] = []
const asked: Array<{ title: string; tier: string; action: string }> = []
let answer: (request: { metadata: { tier: string } }) => Promise<string | undefined> = async () => undefined

const attachClient = (options: { answerWindowMs?: number } = {}) => {
  const client = createBrowserAttach({
    engine: adapter,
    driver,
    policy: createBrowserPolicy(repository),
    ask: async (request) => {
      asked.push({ title: request.title, tier: request.metadata.tier, action: request.metadata.action })
      return answer(request)
    },
    ...options,
  })
  clients.push(client)
  return client
}

describe.skipIf(!run)("the agent's browser over the engine's attach protocol (BU-05)", () => {
  beforeAll(async () => {
    if (!run) return
    engine = await startEngine({ modelUrl: model.url })
    adapter = new Engine(engine.url, engine.authorization)
    repository = new SqliteRoutineRepository(":memory:")
    driver = createRecipeDriver({
      repository,
      dataDir: directory,
      egress: createEgressGuard({ allowLoopbackPorts: [site.port] }),
    })
  }, 120_000)

  // A test that failed half way must not leave the next one a busy browser.
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()))
  })

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.stop()))
    await driver?.stop()
    repository?.close()
    await engine?.stop()
    model.stop()
    site.stop()
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  test("the agent completes a three-step form by refs alone, and reads the page as untrusted", async () => {
    const sessionID = await session()
    const client = attachClient()
    answer = async () => "session"
    asked.length = 0
    await client.attach(sessionID)
    const tab = "const tab = (await tools.browser.tabs.list({})).tabs[0];"
    await turn(
      sessionID,
      `const tab = await tools.browser.tabs.open({ url: "${site.url}/" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e2", text: "Ada" }); await tools.browser.click({ tabID: tab.id, ref: "e3" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e3", text: "ada@example.test" }); await tools.browser.click({ tabID: tab.id, ref: "e4" }); await tools.browser.click({ tabID: tab.id, ref: "e5" }); return await tools.browser.snapshot({ tabID: tab.id })`,
      `${tab} await tools.browser.fill({ tabID: tab.id, ref: "e2", text: "pro" }); await tools.browser.press({ tabID: tab.id, key: "Enter" }); return await tools.browser.snapshot({ tabID: tab.id })`,
    )
    const pages = toolResults().map((result) => (JSON.parse(result) as { content: string }).content)
    expect(pages).toHaveLength(4)
    expect(pages[0]).toContain('- textbox "Name" [ref=e2]')
    expect(pages[1]).toContain('- checkbox "I accept the terms" [ref=e4]')
    expect(pages[3]).toContain("name=Ada email=ada@example.test terms=on plan=pro")
    // Every page text the model read says what it is, in the result itself.
    for (const page of pages) expect(page).toStartWith(UNTRUSTED_NOTICE)
    expect(site.requests.filter((path) => !path.startsWith("/favicon"))).toEqual([
      "/",
      "/contact?name=Ada",
      "/plan?name=Ada&email=ada%40example.test&terms=on",
      "/done?name=Ada&email=ada%40example.test&terms=on&plan=pro",
    ])
    // The reader was asked twice: to open the site, then to click and type on it (each for the session).
    expect(asked.map((entry) => [entry.tier, entry.action])).toEqual([
      ["navigate", "browser.tabs.open"],
      ["interact", "browser.fill"],
    ])
    const audit = repository.listBrowserAudit({ sessionID })
    expect(audit.filter((entry) => entry.kind === "action").length).toBe(15)
    await client.detach(sessionID)
  }, 120_000)

  test("with the reader saying no, no action reaches the page, and the model is told why", async () => {
    const sessionID = await session()
    const client = attachClient()
    // Yes once, to put a tab on the site; no to everything after it.
    let answers = 0
    answer = async () => (answers++ === 0 ? "once" : "deny")
    asked.length = 0
    await client.attach(sessionID)
    await turn(sessionID, `const tab = await tools.browser.tabs.open({ url: "${site.url}/" }); return tab.title`)
    const before = site.requests.length
    const shots = repository.listArtifacts({ kind: "screenshot" }).length
    const calls = [
      `tools.browser.snapshot({ tabID: tab.id })`,
      `tools.browser.find({ tabID: tab.id, text: "Next" })`,
      `tools.browser.screenshot({ tabID: tab.id })`,
      `tools.browser.navigate({ tabID: tab.id, url: "${site.url}/long" })`,
      `tools.browser.back({ tabID: tab.id })`,
      `tools.browser.forward({ tabID: tab.id })`,
      `tools.browser.reload({ tabID: tab.id })`,
      `tools.browser.click({ tabID: tab.id, ref: "e3" })`,
      `tools.browser.fill({ tabID: tab.id, ref: "e2", text: "Ada" })`,
      `tools.browser.press({ tabID: tab.id, key: "Enter" })`,
      `tools.browser.scroll({ tabID: tab.id, deltaY: 400 })`,
      `tools.browser.tabs.open({ url: "${site.url}/long" })`,
    ]
    await turn(
      sessionID,
      `const tab = (await tools.browser.tabs.list({})).tabs[0]; const out = []; for (const call of [${calls
        .map((call) => `() => ${call}`)
        .join(
          ", ",
        )}]) { try { await call(); out.push("ran") } catch (error) { out.push(String(error && error.message || error)) } } return out`,
      // Not caught: the refusal is the call's error, and its reason still reaches the model.
      `const tab = (await tools.browser.tabs.list({})).tabs[0]; return await tools.browser.snapshot({ tabID: tab.id })`,
    )
    const results = toolResults()
    const refusals = JSON.parse(results[1]!) as string[]
    expect(refusals).toHaveLength(calls.length)
    for (const refusal of refusals)
      expect(refusal).toStartWith("[browser.denied] The person did not allow the agent to")
    expect(results[2]).toContain("[browser.denied] The person did not allow the agent to read pages on 127.0.0.1")
    expect(asked.length).toBe(1 + calls.length + 1)
    // Nothing reached the site and nothing was captured after the one page the reader allowed.
    expect(site.requests.length).toBe(before)
    expect(repository.listArtifacts({ kind: "screenshot" }).length).toBe(shots)
    const actions = repository.listBrowserAudit({ sessionID }).filter((entry) => entry.kind === "action")
    expect(actions.filter((entry) => entry.tier !== "read" || entry.action !== "browser.tabs.list")).toHaveLength(1)
    await client.detach(sessionID)
  }, 120_000)

  test("an approval not answered in time tells the model to call again; a session without a browser loses the tools", async () => {
    const sessionID = await session()
    const client = attachClient({ answerWindowMs: 500 })
    const late = Promise.withResolvers<void>()
    answer = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve("deny")
          late.resolve()
        }, 3000),
      )
    await client.attach(sessionID)
    await turn(sessionID, `return await tools.browser.tabs.open({ url: "${site.url}/" })`)
    expect(toolResults()[0]).toContain("[browser.approval_pending] The person has not answered yet")

    await client.detach(sessionID)
    expect(driver.get(sessionID)).toBeUndefined()
    await turn(sessionID, `return await tools.browser.tabs.list({})`)
    expect(toolResults()[1]).toContain("Unknown tool 'browser.tabs.list'")
    // The question outlived its command; its answer lands before this test hands the store back.
    await late.promise
  }, 120_000)
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
  await call("POST", `/api/session/${sessionID}/prompt`, { text: "use the browser" })
  await call("POST", `/api/experimental/session/${sessionID}/wait`)
}

/**
 * What each `execute` returned to the model in the session that ran last, in order: the newest
 * request carries the session's whole history, and the tests run one session at a time.
 */
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
