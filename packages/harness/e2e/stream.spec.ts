import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_stream",
  projectID: "p",
  title: "Streaming",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const permission = {
  id: "per_1",
  sessionID: "ses_stream",
  action: "bash",
  resources: ["rm -rf build"],
  metadata: { command: "rm -rf build" },
  time: { created: now },
}

test("a reconnection picks up the permission that was asked while the stream was gone", async ({ page }) => {
  // The engine asks for permission after the first stream ends, so the event announcing it is lost:
  // only a resync on reconnection can surface it. Without one the agent waits, blocked and invisible.
  let streams = 0
  const blocked = () => streams > 1

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_stream/message")
      return route.fulfill({
        json: { data: [{ id: "msg_u", type: "user", text: "Clean up", time: { created: now } }], cursor: {} },
      })
    if (url.pathname === "/api/session/ses_stream/permission")
      return route.fulfill({ json: { data: blocked() ? [permission] : [] } })
    if (/^\/api\/session\/[^/]+\/question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event") {
      streams++
      // Every connection ends at once, which is what a dropped stream looks like to the app.
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Clean up")).toBeVisible()
  await expect(page.locator(".fc-dock-permission")).toHaveCount(0)

  // The app reconnects on its own backoff and asks again for what it may have missed.
  await expect(page.getByText("rm -rf build")).toBeVisible({ timeout: 15_000 })
})

test("the pill admits the app is no longer following the engine", async ({ page }) => {
  let allow = true
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    // The engine keeps answering the health check: only the stream is gone.
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event") {
      if (allow) {
        allow = false
        return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
      }
      return route.abort()
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-status")).toContainText(/Reconnecting|Reconectando/i, { timeout: 15_000 })
})

test("a folder whose stream died is admitted, even while the global one is healthy", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_stream/message")
      return route.fulfill({
        json: { data: [{ id: "m", type: "user", text: "Hola", time: { created: now } }], cursor: {} },
      })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    // The global stream is perfectly healthy and stays open…
    if (url.pathname === "/api/event") return new Promise(() => {})
    // …while the folder's own stream is gone. That folder carries the transcript, so the app is not
    // following the engine, however fine the global stream looks.
    if (url.pathname === "/event") return route.abort()
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Hola")).toBeVisible()
  await expect(page.locator(".fc-status")).toContainText(/Reconnecting|Reconectando/i, { timeout: 15_000 })
})
