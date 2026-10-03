import { expect, test, type Page } from "@playwright/test"

/**
 * Every dialog that opens without a target is reachable by a link (UX-00): `?dialog=<name>`, Settings
 * on a section with `&section=`. The link opens it once and leaves the address as it was without it.
 */

async function open(page: Page, address: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(address)
}

const DIALOGS = [
  ["settings", "Settings"],
  ["about", "About FlupCode"],
  ["stashes", "Saved prompts"],
  ["remote", "Remote control"],
  ["best-of-n", "Best of N"],
  ["memory", "Memory"],
  ["config", "Config (advanced)"],
  ["config-files", "Config files"],
  ["palette", "Search"],
  ["model", "Choose a model"],
  ["folder", "Open folder"],
] as const

for (const [dialog, name] of DIALOGS) {
  test(`?dialog=${dialog} opens ${name}`, async ({ page }) => {
    await open(page, `/?dialog=${dialog}`)
    await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
  })
}

test("Settings opens on the section its link names, over the screen in the path", async ({ page }) => {
  await open(page, "/runs?dialog=settings&section=shortcuts")
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true")
  // The screen stays, and the link is gone: closing the dialog leaves no trace in the address.
  await expect(page).toHaveURL(/\/runs$/)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
  await expect(page).toHaveURL(/\/runs$/)
})

test("a link that names no dialog opens none", async ({ page }) => {
  await open(page, "/?dialog=rename")
  await expect(page.locator(".fc-app")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
