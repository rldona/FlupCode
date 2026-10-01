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
 * selected while no list carries it. Without polling it anyway, a run whose end event is lost — a
 * stream that died, an engine restarted — spins forever and the composer stays on Stop until a
 * reload.
 */
test("a session opened from the palette still has its run polled", async ({ page }) => {
  let busy = true
  let activeCalls = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    // Only the search knows this session; no page of the list ever carries it.
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { data: url.searchParams.get("search") ? [hidden] : [], cursor: {} } })
    // The engine says it is working, then that it is done. No event ever arrives to say so.
    if (url.pathname === "/api/session/active") {
      activeCalls++
      return route.fulfill({ json: { data: busy ? { ses_bug: { type: "running" } } : {} } })
    }
    if (url.pathname === "/api/session/ses_bug/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await page.keyboard.press("Control+k")
  await page.locator(".fc-palette-input").fill("deep")
  await page.locator(".fc-palette-item", { hasText: "Deep search hit" }).first().click()

  // The engine reported it active, and the poll that asks again is the only thing that can take it
  // back to Send.
  await expect(page.locator(".fc-input-stop")).toBeVisible({ timeout: 15_000 })
  const callsWhileBusy = activeCalls
  busy = false
  await expect(page.locator(".fc-input-stop")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator(".fc-input-send")).toBeVisible()
  expect(activeCalls).toBeGreaterThan(callsWhileBusy)
})
