import { expect, test } from "@playwright/test"

const now = Date.now()

/** Four sessions, each in its own folder, all of them on screen at once. */
const sessions = ["alpha", "beta", "gamma", "delta"].map((name, index) => ({
  id: `ses_${name}`,
  projectID: "p",
  title: name,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now + index, updated: now + index },
  location: { directory: `/work/${name}` },
}))

// A browser allows six connections to one origin over HTTP/1.1, and every event stream holds one for
// as long as it lives. Measured against a real engine: at six, nothing else answers at all and the
// window never recovers — the tab has to be closed. The app must leave itself room to fetch.
test("the window never holds more event streams open than the browser can spare", async ({ page }) => {
  let open = 0
  let peak = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_alpha"))
    // Every pane on screen pulls its folder in, which is what used to push the count up.
    window.localStorage.setItem("flupcode.splitActive", JSON.stringify(true))
    window.localStorage.setItem("flupcode.splitPanes", JSON.stringify(["ses_beta", "ses_gamma", "ses_delta"]))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    // Held open, like a healthy stream, and counted while it is.
    if (url.pathname === "/api/event") {
      open++
      peak = Math.max(peak, open)
      return new Promise(() => {})
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-session-pane, .fc-transcript").first()).toBeVisible()
  await page.waitForTimeout(3_000)

  // OpenCode 2 carries every folder on its one global stream, so however many folders are on screen
  // the window holds that one, and every other connection is left for the app's own calls.
  expect(peak).toBe(1)
})
