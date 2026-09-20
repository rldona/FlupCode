import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_k",
  projectID: "p",
  title: "Keybinds",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

async function open(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_k"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "feature", default_branch: "main" } })
    if (url.pathname === "/vcs/status") return route.fulfill({ json: [] })
    if (/\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(children|todo|permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

async function openSettings(page: Page) {
  // The palette itself opens Settings, which is also what the changed key must keep doing.
  await page.keyboard.press("Control+k")
  await page.locator(".fc-palette-input").fill("settings")
  await page.locator(".fc-palette-item", { hasText: "Customize" }).first().click()
  await expect(page.getByRole("dialog", { name: "Customize" })).toBeVisible()
  // Settings is a rail of sections now, so the shortcuts have to be asked for.
  await page.getByRole("tab", { name: "Shortcuts" }).click()
}

test("the palette key can be changed, and the new one opens it", async ({ page }) => {
  await open(page)
  await openSettings(page)

  const keycap = page.locator(".fc-settings-row", { hasText: "Command palette" }).locator(".fc-keycap")
  await keycap.click()
  await page.keyboard.press("Control+Shift+J")
  // The capture writes the binding it read, in symbols.
  await expect(keycap).toHaveText("⌘⇧J")

  await page.getByRole("dialog", { name: "Customize" }).getByRole("button", { name: "Close" }).click()

  // The old key no longer opens it; the new one does.
  await page.keyboard.press("Control+k")
  await expect(page.locator(".fc-palette")).toHaveCount(0)
  await page.keyboard.press("Control+Shift+J")
  await expect(page.locator(".fc-palette")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".fc-palette")).toHaveCount(0)
})

test("deleting a session asks in the app's own dialog, not the browser's", async ({ page }) => {
  const removed: string[] = []
  await open(page)
  await page.route("**/session/ses_k", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    removed.push("ses_k")
    return route.fulfill({ json: true })
  })

  await page.locator(".fc-session-row", { hasText: "Keybinds" }).first().locator(".fc-session-action").click()
  await page.locator(".fc-menu-item", { hasText: "Delete" }).click()

  const dialog = page.getByRole("dialog", { name: /Delete this session/ })
  await expect(dialog).toBeVisible()
  // Cancelling leaves the session where it was, and nothing was deleted.
  await dialog.getByRole("button", { name: /Cancel|Cancelar/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(".fc-session-row", { hasText: "Keybinds" })).toHaveCount(1)
  expect(removed).toEqual([])
})
