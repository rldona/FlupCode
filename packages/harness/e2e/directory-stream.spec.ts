import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_dir",
  projectID: "p",
  title: "In a project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const legacyMessages = (text: string) => [
  {
    info: { id: "msg_u", sessionID: "ses_dir", role: "user", time: { created: now } },
    parts: [{ id: "p_u", type: "text", text: "Run it" }],
  },
  {
    info: { id: "msg_a", sessionID: "ses_dir", role: "assistant", time: { created: now + 1 }, agent: "build" },
    parts: [{ id: "p_a", type: "text", text }],
  },
]

// A legacy turn — which is what every chat is today, and what Code becomes — streams its messages
// and its status only on its own folder's stream. Before this, the app followed the chats folder
// alone, so anything a legacy client wrote in a project only showed up by luck on the next refetch.
test("the open session's folder is followed, not only the chats folder", async ({ page }) => {
  let answer = "First answer"
  let streams = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_dir"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/path")
      return route.fulfill({ json: { home: "/home", state: "/state", config: "/config", directory: "/work/demo" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_dir/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: legacyMessages(answer) })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    if (url.pathname === "/event") {
      // Only the project's own stream carries this turn; the chats folder never sees it.
      if (url.searchParams.get("directory") !== "/work/demo")
        return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
      const first = streams++ === 0
      const events = first
        ? []
        : [{ type: "message.updated", properties: { info: { id: "msg_a", sessionID: "ses_dir", role: "assistant" } } }]
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("First answer")).toBeVisible()

  // The engine writes a new answer and says so on the project's stream; the app must pick it up.
  answer = "Second answer"
  await expect(page.getByText("Second answer")).toBeVisible({ timeout: 15_000 })
})
