import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_store",
  projectID: "p",
  title: "Streaming",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const history = [
  {
    info: { id: "msg_u", sessionID: "ses_store", role: "user", time: { created: now } },
    parts: [{ id: "p_u", type: "text", text: "Write the helper" }],
  },
]

// What the engine sends while a turn runs: the message first, then its parts, then the text of each
// part a slice at a time.
const turn = [
  {
    type: "message.updated",
    properties: {
      info: { id: "msg_a", sessionID: "ses_store", role: "assistant", agent: "build", time: { created: now + 1 } },
    },
  },
  {
    type: "message.part.updated",
    properties: { part: { id: "p_a", messageID: "msg_a", sessionID: "ses_store", type: "text", text: "Writing " } },
  },
  {
    type: "message.part.delta",
    properties: { sessionID: "ses_store", messageID: "msg_a", partID: "p_a", field: "text", delta: "the " },
  },
  {
    type: "message.part.delta",
    properties: { sessionID: "ses_store", messageID: "msg_a", partID: "p_a", field: "text", delta: "helper now" },
  },
  {
    type: "message.part.updated",
    properties: {
      part: {
        id: "t_a",
        messageID: "msg_a",
        sessionID: "ses_store",
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "/work/demo/a.ts" }, output: "wrote a.ts" },
      },
    },
  },
]

test("a running turn is built from its events, not from refetching the history", async ({ page }) => {
  let historyReads = 0
  let streams = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_store"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_store/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) {
      historyReads++
      return route.fulfill({ json: history })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    // Held open, like a healthy stream: a body that closes makes the app reconnect, and every
    // reconnection refetches the history, which is exactly what this test must not rely on.
    if (url.pathname === "/api/event") return new Promise(() => {})
    if (url.pathname === "/event") {
      // The first connection is empty so the history lands first; the turn comes on the next one.
      const events = streams++ === 1 ? turn : [{ type: "server.heartbeat", properties: {} }]
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Write the helper")).toBeVisible()
  const readsAfterLoad = historyReads

  // The answer, its deltas and its tool all arrive as events and land in the transcript.
  await expect(page.getByText("Writing the helper now")).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(".fc-toolgroup-line, .fc-tool-header").first()).toBeVisible()

  // And none of it cost a refetch: every event used to schedule a full reload of the history.
  expect(historyReads).toBe(readsAfterLoad)
})
