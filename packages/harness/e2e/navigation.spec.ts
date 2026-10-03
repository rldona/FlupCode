import { expect, test, type Page } from "@playwright/test"
import { DESTINATIONS, SETTINGS_GROUPS, offered, urlForDestination, type Destination } from "../src/navigation"

/**
 * One navigation model (UX-01): every destination opens from its address and from the search under
 * the one name the registry gives it, the sidebar and the profile menu list what the registry says,
 * and the addresses from before keep working.
 */

async function open(page: Page, address: string, view: "code" | "chat" = "code") {
  await page.addInitScript((view: string) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.view", JSON.stringify(view))
  }, view)
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

/** What the reader sees once a destination is open: its screen, its dialog, or Settings on its tab. */
async function expectOpen(page: Page, entry: Destination) {
  if (entry.screen) {
    await expect(page.getByRole("region", { name: entry.title, exact: true }).first()).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${entry.screen}$`))
    return
  }
  if (entry.section) {
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await expect(settings).toBeVisible()
    await expect(settings.getByRole("tab", { name: entry.title, exact: true })).toHaveAttribute("aria-selected", "true")
    return
  }
  await expect(page.getByRole("dialog", { name: entry.title, exact: true })).toBeVisible()
}

for (const entry of DESTINATIONS) {
  test(`${entry.id}: its address opens ${entry.title}`, async ({ page }) => {
    await open(page, urlForDestination(entry))
    await expectOpen(page, entry)
  })
}

// The browser build: Actions are the desktop app's, and the search does not offer them here.
for (const entry of offered(false)) {
  test(`${entry.id}: the search opens ${entry.title}`, async ({ page }) => {
    await open(page, "/")
    await page.getByRole("button", { name: "Search", exact: true }).click()
    const palette = page.getByRole("dialog", { name: "Search", exact: true })
    await palette.getByRole("textbox", { name: "Search" }).fill(entry.title)
    const exact = new RegExp(`^${entry.title.replace(/[()]/g, "\\$&")}$`)
    await palette.locator(".fc-palette-item", { has: page.locator(".fc-palette-label", { hasText: exact }) }).first().click()
    await expectOpen(page, entry)
  })
}

for (const view of ["code", "chat"] as const) {
  test(`the ${view} sidebar lists the work primitives, in the registry's order`, async ({ page }) => {
    await open(page, "/", view)
    const names = DESTINATIONS.filter((entry) => entry.home === "sidebar").map((entry) => entry.title)
    await expect(page.locator(".fc-nav .fc-nav-item")).toContainText(names)
    // Settings is not a second item here: it lives in the profile menu, with its shortcut.
    await expect(page.locator(".fc-nav").getByText("Customize")).toHaveCount(0)
    await page.locator(".fc-nav .fc-nav-item", { hasText: "Runs" }).click()
    await expect(page.getByRole("region", { name: "Runs", exact: true })).toBeVisible()
  })
}

test("the profile menu lists the rest, in the registry's order", async ({ page }) => {
  await open(page, "/")
  await page.locator(".fc-profile-button").click()
  const names = offered(false)
    .filter((entry) => entry.home === "menu")
    .map((entry) => entry.title)
  await expect(page.locator(".fc-menu .fc-menu-label")).toHaveText(names)
  await page.locator(".fc-menu").getByText("Settings", { exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible()
})

test("Settings holds its sections and the configuration dialogs, nothing else", async ({ page }) => {
  await open(page, "/?dialog=settings&section=advanced")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings.getByRole("tab")).toHaveText(SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.label)))
  const panel = settings.getByRole("tabpanel")
  await expect(panel.getByRole("button")).toHaveText(["Config (advanced)", "Config files"])
  await panel.getByRole("button", { name: "Config files" }).click()
  await expect(page.getByRole("dialog", { name: "Config files", exact: true })).toBeVisible()
})

test("the shortcut for Settings opens it", async ({ page }) => {
  await open(page, "/")
  await page.locator(".fc-app").waitFor()
  await page.keyboard.press("Control+,")
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible()
})

test("an old address leads where it moved, and Back does not return to it", async ({ page }) => {
  await open(page, "/usage")
  await expect(page.getByRole("region", { name: "Cost", exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/cost$/)

  await page.goto("/agents")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(/\/$/)

  await page.goto("/runs?dialog=skills")
  await expect(page.getByRole("region", { name: "Skills", exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/skills$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/agents$|\/$/)
})
