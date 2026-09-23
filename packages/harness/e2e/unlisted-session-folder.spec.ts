import { expect, test } from "@playwright/test"

const now = Date.now()
const directory = "/work/demo"

const hidden = {
  id: "ses_bug",
  projectID: "p",
  title: "Deep search hit",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory },
}

const messages = {
  data: [{ id: "msg_u", type: "user", text: "Run it", time: { created: now } }],
  cursor: {},
}

/**
 * The session list is one page; the palette's search reaches past it. A session opened from there is
 * selected while no list carries it, so its folder is known only from the search answer. Without
 * remembering it there is nothing to follow and nothing to poll: a run whose `session.idle` is lost
 * — a stream that died, an engine restarted — spins forever and the composer stays on Stop until a
 * reload.
 */
test("a session opened from the palette still has its folder polled", async ({ page }) => {
  const statusCalls = new Map<string, number>()

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    // Only the search knows this session; no page of the list ever carries it.
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { data: url.searchParams.get("search") ? [hidden] : [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") {
      // The folder says it is working once, then that it is done. No `session.idle` ever arrives.
      const folder = url.searchParams.get("directory") ?? ""
      const seen = statusCalls.get(folder) ?? 0
      statusCalls.set(folder, seen + 1)
      return route.fulfill({ json: folder === directory && seen === 0 ? { ses_bug: { type: "busy" } } : {} })
    }
    if (url.pathname === "/api/session/ses_bug/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await page.keyboard.press("Control+k")
  await page.locator(".fc-palette-input").fill("deep")
  await page.locator(".fc-palette-item", { hasText: "Deep search hit" }).first().click()

  // The folder's status map marked it busy, and the poll that asks that same folder is the only
  // thing that can take it back to Send.
  await expect(page.locator(".fc-input-stop")).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(".fc-input-stop")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator(".fc-input-send")).toBeVisible()
  expect(statusCalls.get(directory) ?? 0).toBeGreaterThan(1)
})
