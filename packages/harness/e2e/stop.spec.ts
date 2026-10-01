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
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: { ses_s: { type: "running" } } } })
    if (url.pathname === "/api/session/ses_s/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/api/session/ses_s/interrupt") {
      record()
      return route.fulfill({ json: {} })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { calls }
}

test("the stop button interrupts the session's running execution", async ({ page }) => {
  const harness = await openRunningSession(page)

  await page.locator(".fc-input-stop").click()

  // OpenCode 2 stops a turn through the session's interrupt, which cancels the running tool too.
  await expect.poll(() => harness.calls.some((call) => call.path === "/api/session/ses_s/interrupt")).toBe(true)
  expect(harness.calls.find((call) => call.path === "/api/session/ses_s/interrupt")?.method).toBe("POST")
})
