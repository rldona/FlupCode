import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_cap",
  projectID: "p",
  title: "Capabilities",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

/**
 * Opens the app against a harness server whose `/harness/health` may or may not list the H-18
 * capabilities, and records whether the client asked for the routes behind them.
 */
async function open(page: Page, capabilities: string[] | undefined) {
  const asked: string[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, ...(capabilities ? { capabilities } : {}) } } })
    if (url.pathname === "/harness/session-prefs" || url.pathname === "/harness/stash") {
      asked.push(url.pathname)
      return route.fulfill({ json: { data: [] } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return asked
}

test("a client does not ask an older server for routes it does not declare", async ({ page }) => {
  const asked = await open(page, undefined)
  // Give the connect flow time to settle; the point is that these are never called.
  await page.waitForTimeout(600)
  expect(asked).toEqual([])
})

test("a server that lists the capabilities is asked for them", async ({ page }) => {
  const asked = await open(page, ["session-prefs", "stash"])
  await expect.poll(() => asked).toContain("/harness/session-prefs")
  expect(asked).toContain("/harness/stash")
})
