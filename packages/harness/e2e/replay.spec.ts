import { expect, test, type Page } from "@playwright/test"

const session = {
  id: "ses_x",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/work/demo" },
}

const events = [
  {
    id: "e1",
    type: "session.next.step.started",
    durable: { aggregateID: "ses_x", seq: 1, version: 1 },
    data: { timestamp: 1_700_000_000_000, sessionID: "ses_x" },
  },
  {
    id: "e2",
    type: "session.next.tool.called",
    durable: { aggregateID: "ses_x", seq: 2, version: 1 },
    data: { timestamp: 1_700_000_001_000, sessionID: "ses_x", tool: "bash" },
  },
  {
    id: "e3",
    type: "session.next.step.ended",
    durable: { aggregateID: "ses_x", seq: 3, version: 1 },
    data: { timestamp: 1_700_000_002_000, sessionID: "ses_x" },
  },
]

async function open(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_x/history") return route.fulfill({ json: { data: events, hasMore: false } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => route.fulfill({ json: { data: [] } }))
  await page.goto("/replay")
}

test("a session is replayed event by event, and the scrubber walks it", async ({ page }) => {
  await open(page)

  // The summary says what is in it before the reader steps through it.
  const counts = page.locator(".fc-replay-counts")
  await expect(counts).toContainText("Step started")
  await expect(counts).toContainText("Called a tool")

  // The event names the tool it was about, not just its type.
  const log = page.locator(".fc-replay-log")
  await expect(log.locator(".fc-replay-event")).toHaveCount(3)
  await expect(log).toContainText("bash")
  await expect(log.locator(".fc-replay-seq").first()).toHaveText("1")

  // Scrub back: only what happened up to that point is shown.
  const range = page.locator(".fc-replay-range")
  await range.fill("1")
  await expect(page.locator(".fc-replay-position")).toContainText("1 / 3")
  await expect(log.locator(".fc-replay-event")).toHaveCount(1)

  // And forward again, to the end.
  await range.fill("3")
  await expect(log.locator(".fc-replay-event")).toHaveCount(3)
})
