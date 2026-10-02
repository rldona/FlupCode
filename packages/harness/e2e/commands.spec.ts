import { expect, test, type Page } from "@playwright/test"
import { BUILTIN_COMMANDS } from "../src/commands"

// TI-13: a built-in typed in the composer runs the same thing the palette runs. Before the registry,
// the ones only the palette knew (`files`, `providers`, `rename`, ...) went to the engine as unknown
// commands, creating a session first.

const now = Date.now()

const session = {
  id: "ses_cmd",
  projectID: "p",
  title: "Commands",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

async function openApp(page: Page, options: { selected?: string } = {}) {
  await page.addInitScript((selected?: string) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
    if (selected) window.localStorage.setItem("flupcode.selectedSession", JSON.stringify(selected))
  }, options.selected)
  // Every write the engine is asked for: a built-in must not cause any.
  const writes: string[] = []
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["files"] } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "GET") writes.push(`${request.method()} ${url.pathname}`)
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/\/message$/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/command")
      return route.fulfill({ json: { data: [{ name: "review", description: "Review the diff" }] } })
    if (url.pathname === "/api/fs/list") return route.fulfill({ json: { location: {}, data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-composer textarea").first()).toBeVisible()
  return writes
}

const type = async (page: Page, text: string) => {
  const composer = page.locator(".fc-composer textarea").first()
  await composer.fill(text)
  await composer.press("Enter")
}

test("/files typed in the composer opens Files and never reaches the engine", async ({ page }) => {
  const writes = await openApp(page)
  await type(page, "/files")
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible()
  await expect(page.locator(".fc-composer textarea").first()).toHaveValue("")
  expect(writes).toEqual([])
})

test("the built-ins only the palette knew run from the composer too", async ({ page }) => {
  const writes = await openApp(page, { selected: "ses_cmd" })

  await type(page, "/providers")
  const settings = page.getByRole("dialog")
  await expect(settings.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(settings).toHaveCount(0)

  await type(page, "/rename")
  await expect(page.getByRole("dialog").getByText("Rename", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")

  expect(writes).toEqual([])
})

test("the slash menu lists every built-in, grouped, and then the engine's commands", async ({ page }) => {
  await openApp(page, { selected: "ses_cmd" })
  await page.locator(".fc-composer textarea").first().fill("/")
  const menu = page.locator(".fc-command-menu")
  // The web app hides the desktop-only ones, and nothing else.
  const builtins = BUILTIN_COMMANDS.filter((command) => !command.desktop)
  for (const command of builtins) await expect(menu.getByText(`/${command.id}`, { exact: true })).toBeVisible()
  await expect(menu.locator(".fc-command-group")).toHaveText(["Session", "Go to", "App", "Commands"])
  await expect(menu.getByText("/review", { exact: true })).toBeVisible()
})
