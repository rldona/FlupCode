import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const sessions = [
  {
    id: "ses_1",
    projectID: "p",
    title: "Alpha",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: "/work/demo" },
  },
  {
    id: "ses_2",
    projectID: "p",
    title: "Beta",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now - 1 },
    location: { directory: "/work/demo" },
  },
]

async function open(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_1"))
    window.localStorage.setItem("flupcode.sessionTabs", JSON.stringify(["ses_1", "ses_2"]))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("the open sessions are a strip: switching selects, closing goes to the neighbour", async ({ page }) => {
  await open(page)

  const tabs = page.locator(".fc-session-tab")
  await expect(tabs).toHaveCount(2)
  // The selected session is the active tab, and the other one is not.
  await expect(page.locator(".fc-session-tab-active")).toContainText("Alpha")
  await expect(tabs.nth(1).locator(".fc-session-tab-name")).toHaveAttribute("aria-selected", "false")

  // Switching a tab is selecting that session.
  await tabs.nth(1).locator(".fc-session-tab-name").click()
  await expect(page.locator(".fc-session-tab-active")).toContainText("Beta")
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("flupcode.selectedSession"))).toContain("ses_2")

  // Closing the active tab leaves its neighbour active. With one tab left the strip is not shown at
  // all — the top bar already names the session — so what matters is what is selected.
  await page.locator(".fc-session-tab-active .fc-session-tab-close").click()
  await expect(page.locator(".fc-session-tabs")).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("flupcode.selectedSession"))).toContain("ses_1")
  // The tab is gone from the strip; the session itself is still there.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("flupcode.sessionTabs")))
    .not.toContain("ses_2")
})
