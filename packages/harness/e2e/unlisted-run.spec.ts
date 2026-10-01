import { expect, test } from "@playwright/test"

const now = Date.now()

// The session under test lives in this folder, but the engine's list does not carry it: it was opened
// from the palette, or it is a routine/worktree run outside the page. Only the engine's set of active
// sessions knows it is working.
const directory = "/work/demo"

const listed = {
  id: "ses_other",
  projectID: "p",
  title: "Other",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory },
}

const messages = {
  data: [{ id: "msg_u", type: "user", text: "Run it", time: { created: now } }],
  cursor: {},
}

// A run the engine reports active is marked busy even when the session list does not name it. If the
// cleanup poll refuses to ask about it — because the session is not in the list — the run never
// clears: the composer stays on Stop, and no event ever arrives to end it.
test("a run in a folder the list does not carry still stops spinning when the engine says it is done", async ({
  page,
}) => {
  let busy = true

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_bug"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [listed], cursor: {} } })
    // The engine reports the run until it is over. No event follows on the stream to say so.
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: busy ? { ses_bug: { type: "running" } } : {} } })
    if (url.pathname === "/api/session/ses_bug/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    // The stream stays empty: the only way the run can end is the poll.
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // The engine reported it active, so the composer offers Stop...
  await expect(page.locator(".fc-input-stop")).toBeVisible()
  busy = false
  // ...and the poll that asks the engine again is what takes it back to Send, with no event.
  await expect(page.locator(".fc-input-stop")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator(".fc-input-send")).toBeVisible()
})
