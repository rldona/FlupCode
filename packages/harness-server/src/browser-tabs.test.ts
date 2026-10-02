import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRecipeDriver } from "./browser"
import type { RecipeDriver } from "./browser"
import { BrowserError } from "./browser-driver"
import { createEgressGuard } from "./browser-egress"
import { startFormSite } from "./browser-form.fixture"
import { renderSnapshot } from "./browser-snapshot"
import { SqliteRoutineRepository } from "./repository"

/**
 * The agent's browser tool on the recipe runner's Chromium (BU-05), against a local site: tabs, an
 * accessibility snapshot with refs, input by those refs, and what happens to a ref the page moved
 * past. The engine and the policy are above this (`browser-attach.engine.test.ts`).
 */
const { chromium } = await import("playwright")
const chromiumPath = chromium.executablePath()
if (process.env.FLUPCODE_REQUIRE_BROWSER === "1" && !existsSync(chromiumPath))
  throw new Error(`FLUPCODE_REQUIRE_BROWSER=1 but Playwright has no Chromium at ${chromiumPath}`)

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}, 15_000)

const start = async () => {
  const site = startFormSite()
  const directory = mkdtempSync(join(tmpdir(), "flupcode-tabs-"))
  const repository = new SqliteRoutineRepository(":memory:")
  const driver = createRecipeDriver({
    repository,
    dataDir: directory,
    egress: createEgressGuard({ allowLoopbackPorts: [site.port] }),
  })
  cleanups.push(
    () => site.stop(),
    () => rmSync(directory, { recursive: true, force: true }),
    () => repository.close(),
    () => driver.stop(),
  )
  await driver.open({ id: "agent", project: "/project", sessionID: "ses_agent" })
  return { site, repository, driver }
}

const refused = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (cause: unknown) => (cause instanceof BrowserError ? cause.code : String(cause)),
  )

describe.skipIf(!existsSync(chromiumPath))("the agent's tabs on the recipe driver (BU-05)", () => {
  test("a snapshot lists the page's elements, each with a ref in document order", async () => {
    const { site, driver } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/`)
    expect(tab).toMatchObject({ url: `${site.url}/`, title: "Sign up", loading: false, canGoForward: false })
    expect(tab.id).toMatch(/^tab_[a-f0-9-]{36}$/)
    const snapshot = await driver.tabs.snapshot("agent", tab.id)
    expect(snapshot.content.split("\n")).toEqual([
      '- heading "Sign up" [level=1] [ref=e1]',
      // A label's text, on its own line; the field it names says it again as its name.
      '- text "Name"',
      '- textbox "Name" [ref=e2]',
      '- button "Next" [ref=e3]',
    ])
    expect(snapshot.truncated).toBe(false)
  })

  test("the three steps go through by refs alone: typing, a checkbox, a click and Enter", async () => {
    const { site, driver } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/`)
    await driver.tabs.snapshot("agent", tab.id)
    await driver.tabs.act("agent", tab.id, { kind: "type", ref: "e2", text: "Ada" })
    const contact = await driver.tabs.act("agent", tab.id, { kind: "click", ref: "e3" })
    expect(contact.url).toBe(`${site.url}/contact?name=Ada`)
    expect(contact.generation).toBeGreaterThan(tab.generation)

    expect((await driver.tabs.snapshot("agent", tab.id)).content).toContain('- checkbox "I accept the terms" [ref=e4]')
    await driver.tabs.act("agent", tab.id, { kind: "type", ref: "e3", text: "ada@example.test" })
    await driver.tabs.act("agent", tab.id, { kind: "click", ref: "e4" })
    expect((await driver.tabs.snapshot("agent", tab.id)).content).toContain(
      '- checkbox "I accept the terms" [checked] [ref=e4]',
    )
    await driver.tabs.act("agent", tab.id, { kind: "click", ref: "e5" })

    await driver.tabs.snapshot("agent", tab.id)
    // A field typed into twice keeps the second text only.
    await driver.tabs.act("agent", tab.id, { kind: "type", ref: "e2", text: "basic" })
    await driver.tabs.act("agent", tab.id, { kind: "type", ref: "e2", text: "pro" })
    const done = await driver.tabs.act("agent", tab.id, { kind: "key", key: "Enter" })
    expect(done.title).toBe("Done")
    expect((await driver.tabs.snapshot("agent", tab.id)).content).toContain(
      "name=Ada email=ada@example.test terms=on plan=pro",
    )
  })

  test("a ref the page moved past fails as stale and acts on nothing", async () => {
    const { site, driver } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/`)
    // No snapshot yet: there is no ref to act by.
    expect(await refused(driver.tabs.act("agent", tab.id, { kind: "click", ref: "e3" }))).toBe("stale_ref")
    await driver.tabs.snapshot("agent", tab.id)
    await driver.tabs.act("agent", tab.id, { kind: "type", ref: "e2", text: "Ada" })
    await driver.tabs.act("agent", tab.id, { kind: "click", ref: "e3" })
    const before = site.requests.length
    // The click navigated: the old page's refs are gone, even though the new page has an e3 too.
    expect(await refused(driver.tabs.act("agent", tab.id, { kind: "click", ref: "e3" }))).toBe("stale_ref")
    expect(site.requests.length).toBe(before)
  })

  test("only a field takes text", async () => {
    const { site, driver } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/`)
    await driver.tabs.snapshot("agent", tab.id)
    expect(await refused(driver.tabs.act("agent", tab.id, { kind: "type", ref: "e3", text: "x" }))).toBe("not_editable")
  })

  test("scroll, back and forward move the tab, and find keeps matching lines", async () => {
    const { site, driver } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/long`)
    const scrolled = await driver.tabs.act("agent", tab.id, { kind: "scroll", deltaY: 1200 })
    await Bun.sleep(200)
    expect((await driver.tabs.focus("agent", tab.id)).title).toStartWith("Long, scrolled to")
    expect(scrolled.canGoBack).toBe(true)
    await driver.tabs.act("agent", tab.id, { kind: "navigate", url: `${site.url}/` })
    const back = await driver.tabs.act("agent", tab.id, { kind: "back" })
    expect(back).toMatchObject({ url: `${site.url}/long`, canGoForward: true })
    expect((await driver.tabs.act("agent", tab.id, { kind: "forward" })).url).toBe(`${site.url}/`)
    expect((await driver.tabs.snapshot("agent", tab.id, { find: "next" })).content).toBe('- button "Next" [ref=e3]')
  })

  test("tabs open, list, focus and close; a closed or foreign tab is unavailable", async () => {
    const { site, driver } = await start()
    const first = await driver.tabs.open("agent", `${site.url}/`)
    const second = await driver.tabs.open("agent", `${site.url}/long`)
    expect(await driver.tabs.list("agent")).toMatchObject({
      tabs: [{ id: first.id }, { id: second.id }],
      focusedTabID: second.id,
    })
    expect((await driver.tabs.focus("agent", first.id)).title).toBe("Sign up")
    expect((await driver.tabs.close("agent", second.id)).tabs.map((tab) => tab.id)).toEqual([first.id])
    expect(await refused(driver.tabs.snapshot("agent", second.id))).toBe("tab_unavailable")
    expect(await refused(driver.tabs.focus("agent", `tab_${crypto.randomUUID()}`))).toBe("tab_unavailable")
    // The last tab closes to a blank page, so the live view still has one to show.
    expect(await driver.tabs.close("agent", first.id)).toEqual({ tabs: [], focusedTabID: null })
    expect(driver.get("agent")?.url).toBe("about:blank")
  })

  test("the egress guard holds for the agent's navigations too", async () => {
    const { driver } = await start()
    const tab = await driver.tabs.open("agent")
    const outcome = await driver.tabs
      .act("agent", tab.id, { kind: "navigate", url: "http://169.254.169.254/latest/meta-data" })
      .then(
        () => "navigated",
        (cause: unknown) => (cause as { code?: string }).code,
      )
    expect(outcome).toBe("navigation_blocked")
  })

  test("a screenshot is a screenshot artifact of the session, with its file", async () => {
    const { site, driver, repository } = await start()
    const tab = await driver.tabs.open("agent", `${site.url}/`)
    const shot = await driver.tabs.screenshot("agent", tab.id)
    expect(existsSync(shot.path)).toBe(true)
    expect(shot.bytes).toBeGreaterThan(0)
    expect(repository.getArtifact(shot.artifactId)).toMatchObject({ kind: "screenshot", sessionID: "ses_agent" })
  })
})

describe("the accessibility snapshot (BU-05)", () => {
  test("groups are flattened, repeated text is dropped, values and states are said, and secrets redacted", () => {
    const nodes = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"], backendDOMNodeId: 1 },
      { nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["3", "5", "6"], backendDOMNodeId: 2 },
      {
        nodeId: "3",
        parentId: "2",
        role: { value: "button" },
        name: { value: "Send" },
        childIds: ["4"],
        backendDOMNodeId: 3,
      },
      { nodeId: "4", parentId: "3", role: { value: "StaticText" }, name: { value: "Send" } },
      {
        nodeId: "5",
        parentId: "2",
        role: { value: "textbox" },
        name: { value: "Token" },
        value: { value: "hunter2" },
        properties: [{ name: "required", value: { value: true } }],
        backendDOMNodeId: 5,
      },
      { nodeId: "6", parentId: "2", ignored: true, role: { value: "link" }, backendDOMNodeId: 6 },
    ]
    const rendered = renderSnapshot(nodes, { limit: 1000, redact: (text) => text.replaceAll("hunter2", "[redacted]") })
    expect(rendered.content).toBe('- button "Send" [ref=e1]\n- textbox "Token" [required] [ref=e2]: "[redacted]"')
    expect([...rendered.refs]).toEqual([
      ["e1", { backendNodeId: 3, role: "button" }],
      ["e2", { backendNodeId: 5, role: "textbox" }],
    ])
    expect(renderSnapshot(nodes, { limit: 30, redact: (text) => text })).toMatchObject({
      content: '- button "Send" [ref=e1]',
      truncated: true,
    })
  })
})
