import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_s",
  projectID: "p",
  title: "Stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// One user message with no answer yet, and the engine reports the session as running: that is when
// the composer shows the stop button.
const messages = {
  data: [{ id: "msg_u", type: "user", text: "Run the tests", time: { created: now } }],
  cursor: {},
}

type Harness = {
  /** POSTs the app made, in order. */
  calls: Array<{ path: string; method: string }>
}

async function openRunningSession(page: Page): Promise<Harness> {
  const calls: Harness["calls"] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_s"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const record = () => calls.push({ path: url.pathname, method: request.method() })
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: { ses_s: { type: "running" } } } })
    if (url.pathname === "/session/status") return route.fulfill({ json: { ses_s: { type: "busy" } } })
    if (url.pathname === "/api/session/ses_s/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/session/ses_s/prompt_async") return route.fulfill({ json: {} })
    if (url.pathname === "/session/ses_s/abort") {
      record()
      return route.fulfill({ json: true })
    }
    if (url.pathname === "/api/session/ses_s/interrupt") {
      record()
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/session/ses_s" && request.method() === "PATCH") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/event") {
      const body = `data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body })
    }
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { calls }
}

test("the stop button aborts the legacy run the turn is actually on", async ({ page }) => {
  const harness = await openRunningSession(page)

  await page.locator(".fc-input-stop").click()

  // The prompt went to the legacy runtime, so the stop has to cancel that runner: the v2 interrupt
  // alone is a no-op for a legacy turn and left the running bash unstoppable.
  await expect.poll(() => harness.calls.some((call) => call.path === "/session/ses_s/abort")).toBe(true)
  expect(harness.calls.find((call) => call.path === "/session/ses_s/abort")?.method).toBe("POST")
})
