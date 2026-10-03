/// <reference path="../../bridge-extension/src/chrome.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GROUP_TITLE, SOCKET_PATH } from "@flupcode/bridge-extension/protocol"
import { BRIDGE_EXTENSION_IDS } from "./browser-bridge"
import { launchBridgeBrowser, startBridgeHarness, until } from "./browser-bridge.fixture"
import { BrowserError } from "./browser-driver"
import { NavigationBlockedError, createEgressGuard } from "./browser-egress"
import { startFormSite } from "./browser-form.fixture"
import { SqliteRoutineRepository } from "./repository"

/**
 * FlupCode Bridge against a real Chromium (BU-04): the extension built from its package, loaded
 * unpacked into Playwright's Chromium on a throwaway profile, talking to a harness over its socket.
 * What is proved: pairing is the one click of `POST /harness/bridge/pair`, and the token it hands the
 * extension opens nothing else; the agent's tabs are the FlupCode group's, and a tab outside it is
 * refused by the extension itself even when asked for by id; the egress guard holds redirects; the
 * person takes the browser back from the popup; and when the app closes the debugger lets go.
 *
 *   bun test src/browser-bridge.test.ts
 */
const { chromium } = await import("playwright")
const chromiumPath = chromium.executablePath()
if (process.env.FLUPCODE_REQUIRE_BROWSER === "1" && !existsSync(chromiumPath))
  throw new Error(`FLUPCODE_REQUIRE_BROWSER=1 but Playwright has no Chromium at ${chromiumPath}`)

test("the extension's id is the one the harness lets in", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../../bridge-extension/manifest.json")).json()
  const id = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  expect<string[]>([...BRIDGE_EXTENSION_IDS]).toContain(id)
})

describe.skipIf(!existsSync(chromiumPath))("FlupCode Bridge in Chromium (BU-04)", () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-bridge-test-"))
  const site = startFormSite()
  // A page that sends the browser somewhere the guard refuses: loopback on a port nobody allowed.
  const away = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/private" } }),
  })
  const repository = new SqliteRoutineRepository(":memory:")
  let harness: ReturnType<typeof startBridgeHarness>
  let browser: Awaited<ReturnType<typeof launchBridgeBrowser>>

  beforeAll(async () => {
    harness = startBridgeHarness({
      repository,
      egress: createEgressGuard({ allowLoopbackPorts: [site.port, away.port ?? 0] }),
      dataDir: directory,
    })
    browser = await launchBridgeBrowser()
  }, 60_000)

  afterAll(async () => {
    await browser?.stop()
    harness?.stop()
    away.stop(true)
    site.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const status = async () =>
    (await harness.request("GET", "/harness/bridge")).body.data as {
      connected: { id: string; browser: string } | null
      waiting: Array<{ id: string; browser: string; code: string }>
      paired: Array<{ id: string }>
    }

  test("pairing takes one click from the app, and the extension's token opens nothing else", async () => {
    await browser.connectTo(harness.port)
    const waiting = await until(status, (value) => value.waiting.length === 1)
    expect(waiting.connected).toBeNull()
    // The popup shows the same code the app does, so the person can tell it is their browser.
    const popup = await browser.context.newPage()
    await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`)
    await until(() => popup.locator("#code").textContent(), (text) => text === waiting.waiting[0]!.code)
    await popup.close()

    // The one click.
    const paired = await harness.request("POST", "/harness/bridge/pair", { id: waiting.waiting[0]!.id })
    expect(paired.status).toBe(200)
    const connected = await until(status, (value) => value.connected !== null)
    expect(connected.waiting).toHaveLength(0)
    expect(connected.paired).toHaveLength(1)

    // The extension kept its token; the harness kept only its hash.
    const token = (await browser.worker.evaluate(() => chrome.storage.local.get(["token"]))).token as string
    expect(token.length).toBeGreaterThan(20)
    const file = readFileSync(join(directory, "paired-browsers.json"), "utf8")
    expect(file).not.toContain(token)
    expect(file).toContain(createHash("sha256").update(token).digest("hex"))

    // The `bridge` scope (P7): no route takes the extension's token, not even the bridge's own.
    for (const path of ["/harness/bridge", "/harness/browser/session", "/harness/runs", "/harness/artifacts"])
      expect((await harness.request("GET", path, undefined, token)).status).toBe(403)
    expect((await harness.request("POST", "/harness/bridge/pair", { id: "x" }, token)).status).toBe(403)
    // Only the extension opens the socket: a page cannot, whatever it sends.
    const page = await fetch(`${harness.url}${SOCKET_PATH}`, {
      headers: { upgrade: "websocket", connection: "Upgrade", origin: "https://example.com", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    })
    expect(page.status).toBe(403)
  }, 60_000)

  test("the agent works only in the FlupCode tab group, and cannot read a tab outside it", async () => {
    const driver = harness.bridge.driver
    // The person's own tab, outside the group.
    const own = await browser.context.newPage()
    await own.goto(`${site.url}/long`)
    await driver.open({ id: "session-1", project: directory, sessionID: "session-1" })
    expect((await driver.tabs.list("session-1")).tabs).toEqual([])

    // The agent opens a tab: it lands in the FlupCode group and fills a form there by refs.
    const tab = await driver.tabs.open("session-1", `${site.url}/`)
    const chromeTabs = await browser.chromeTabs()
    expect(chromeTabs.find((entry) => entry.url === `${site.url}/`)?.group).toBe(GROUP_TITLE)
    expect(chromeTabs.find((entry) => entry.url === `${site.url}/long`)?.group).toBeUndefined()
    const first = await driver.tabs.snapshot("session-1", tab.id)
    expect(first.content).toContain('- textbox "Name" [ref=e2]')
    await driver.tabs.act("session-1", tab.id, { kind: "type", ref: "e2", text: "Ada" })
    const next = await driver.tabs.act("session-1", tab.id, { kind: "click", ref: "e3" })
    expect(next.url).toBe(`${site.url}/contact?name=Ada`)
    expect(next.generation).toBeGreaterThan(tab.generation)

    // Only the group's tab is listed; the person's tab never is.
    const listed = await driver.tabs.list("session-1")
    expect(listed.tabs.map((entry) => entry.url)).toEqual([`${site.url}/contact?name=Ada`])

    // A tab the person takes out of the group is out of reach at once, even by the id the agent had:
    // the extension refuses it, not only the harness.
    const grouped = (await browser.chromeTabs()).find((entry) => entry.group === GROUP_TITLE)!
    await browser.worker.evaluate((tabId) => chrome.tabs.ungroup([tabId]), grouped.tabId)
    const refused = await driver.tabs.snapshot("session-1", tab.id).catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(BrowserError)
    expect((refused as BrowserError).code).toBe("out_of_scope")
    expect((await driver.tabs.list("session-1")).tabs).toEqual([])

    // A tab the person hands over from the popup joins the group, and the agent can read it.
    await own.bringToFront()
    const popup = await browser.context.newPage()
    await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`)
    await own.bringToFront()
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "hand" }))
    await popup.close()
    const handed = await until(
      () => driver.tabs.list("session-1"),
      (value) => value.tabs.some((entry) => entry.url === `${site.url}/long`),
    )
    const longTab = handed.tabs.find((entry) => entry.url === `${site.url}/long`)!
    expect((await driver.tabs.snapshot("session-1", longTab.id)).content).toContain("Long")
    await own.close()
    await driver.close("session-1")
  }, 60_000)

  test("the egress guard holds the agent's navigations, redirects included", async () => {
    const driver = harness.bridge.driver
    await driver.open({ id: "session-2", project: directory })
    const tab = await driver.tabs.open("session-2")
    const direct = await driver.tabs
      .act("session-2", tab.id, { kind: "navigate", url: "http://10.0.0.1/" })
      .catch((cause: unknown) => cause)
    expect(direct).toBeInstanceOf(NavigationBlockedError)
    // The first hop is allowed; the redirect to a refused address is stopped in the browser.
    const redirected = await driver.tabs
      .act("session-2", tab.id, { kind: "navigate", url: `http://127.0.0.1:${away.port}/` })
      .catch((cause: unknown) => cause)
    expect(redirected).toBeInstanceOf(NavigationBlockedError)
    expect((redirected as NavigationBlockedError).url).toBe("http://127.0.0.1:9/private")
    await driver.close("session-2")
  }, 60_000)

  test("the person takes the browser back from the popup, and the session ends", async () => {
    const driver = harness.bridge.driver
    await driver.open({ id: "session-3", project: directory })
    const tab = await driver.tabs.open("session-3", `${site.url}/`)
    await driver.tabs.snapshot("session-3", tab.id)
    expect((await browser.attachedTabs()).length).toBeGreaterThan(0)
    const popup = await browser.context.newPage()
    await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`)
    await popup.locator("#take-back").click()
    await until(() => driver.get("session-3"), (value) => value === undefined)
    expect(await browser.attachedTabs()).toEqual([])
    expect((await browser.chromeTabs()).filter((entry) => entry.group === GROUP_TITLE)).toEqual([])
    await popup.close()
  }, 60_000)

  test("closing the app disconnects the debugger", async () => {
    const driver = harness.bridge.driver
    await driver.open({ id: "session-4", project: directory })
    const tab = await driver.tabs.open("session-4", `${site.url}/`)
    await driver.tabs.snapshot("session-4", tab.id)
    const attached = await browser.attachedTabs()
    expect(attached).toHaveLength(1)
    // While the agent holds the tab, the page says so. (Its tab is the newest on that address.)
    const page = browser.context.pages().findLast((entry) => entry.url() === `${site.url}/`)!
    expect(await page.evaluate(() => !!document.getElementById("flupcode-bridge-indicator"))).toBe(true)
    harness.stop()
    await until(() => browser.attachedTabs(), (value) => value.length === 0)
    // The page is left as it was, without the indicator.
    expect(await page.evaluate(() => document.getElementById("flupcode-bridge-indicator"))).toBeNull()
    expect(driver.get("session-4")).toBeUndefined()
  }, 60_000)
})

describe.skipIf(!existsSync(chromiumPath))("FlupCode Bridge refuses on its own (BU-04)", () => {
  /**
   * A harness that asks for too much: the extension's own checks, with nothing in the harness to
   * stop the request first. It answers `hello` as paired and then sends whatever the test says.
   */
  test("a tab outside the group and a CDP method outside the subset are refused by the extension", async () => {
    const answers = new Map<number, unknown>()
    const sockets: Array<{ send: (text: string) => void }> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, bunServer) => (bunServer.upgrade(request, { data: undefined }) ? undefined : new Response("no")),
      websocket: {
        message(socket, data) {
          const message = JSON.parse(String(data)) as { type: string; id?: number }
          if (message.type === "hello") {
            sockets.push(socket)
            socket.send(JSON.stringify({ type: "welcome", paired: true }))
          }
          if (message.id !== undefined) answers.set(message.id, message)
        },
      },
    })
    const browser = await launchBridgeBrowser()
    try {
      const outside = await browser.context.newPage()
      await outside.goto("about:blank")
      await browser.connectTo(server.port ?? 0)
      const socket = (await until(() => sockets[0], (value) => value !== undefined, 15_000, "the extension's hello"))!
      const outsideTab = (await browser.chromeTabs()).find((entry) => entry.group === undefined)!.tabId
      const ask = async (id: number, method: string, params: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "request", id, method, params }))
        return until(() => answers.get(id), (value) => value !== undefined, 15_000, `the answer to ${method}`)
      }
      expect(await ask(1, "cdp", { tabId: outsideTab, method: "Accessibility.getFullAXTree" })).toMatchObject({
        type: "error",
        code: "out_of_scope",
      })
      expect(await ask(2, "tabs.focus", { tabId: outsideTab })).toMatchObject({ type: "error", code: "out_of_scope" })
      // Even in the group, nothing outside the fixed subset: no script, no cookies.
      const opened = (await ask(3, "tabs.open", {})) as { result: { tabId: number } }
      for (const [id, method] of [
        [4, "Runtime.evaluate"],
        [5, "Network.getCookies"],
        [6, "Target.createTarget"],
      ] as const)
        expect(await ask(id, "cdp", { tabId: opened.result.tabId, method, params: {} })).toMatchObject({
          type: "error",
          code: "unsupported",
        })
      expect(
        await ask(7, "cdp", { tabId: opened.result.tabId, method: "Page.navigate", params: { url: "javascript:alert(1)" } }),
      ).toMatchObject({ type: "error", code: "navigation_blocked" })
      // Nothing was attached for any of it.
      expect(await browser.attachedTabs()).toEqual([])
    } finally {
      await browser.stop()
      server.stop(true)
    }
  }, 60_000)
})
