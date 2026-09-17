import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_compact",
  projectID: "p",
  title: "Compaction",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const user = (id: string, text: string, created: number) => ({
  id,
  sessionID: "ses_compact",
  type: "user",
  text,
  time: { created, completed: created },
})
const assistant = (id: string, text: string, created: number, tokens?: { input: number; read: number }) => ({
  id,
  sessionID: "ses_compact",
  type: "assistant",
  agent: "build",
  model: { providerID: "openai", id: "gpt" },
  cost: 0,
  tokens: {
    input: tokens?.input ?? 0,
    output: 0,
    reasoning: 0,
    cache: { read: tokens?.read ?? 0, write: 0 },
  },
  time: { created, completed: created + 1 },
  content: [{ type: "text", id: `${id}_p`, text }],
})
/** What the engine writes when a session is compacted, in v2's own message type. */
const compaction = (id: string, reason: "auto" | "manual", summary: string, created: number) => ({
  id,
  sessionID: "ses_compact",
  type: "compaction",
  reason,
  summary,
  recent: "",
  time: { created },
})

const history = [
  user("u1", "Haz A y B", now),
  assistant("a1", "Hecha A.", now + 1),
  compaction("c1", "manual", "## Resumen\n\n- A quedó hecha.", now + 10),
  user("u2", "Sigue", now + 20),
  assistant("a2", "Voy.", now + 21),
  compaction("c2", "auto", "## Resumen\n\n- A y B hechas.", now + 30),
]

async function openSession(page: Page, messages = history) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_compact"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_compact/message")
      return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("a compaction is a marked boundary, not one more answer", async ({ page }) => {
  await openSession(page)

  const markers = page.locator(".fc-compaction")
  await expect(markers).toHaveCount(2)
  // A manual compaction says so; one the engine chose reads quieter.
  await expect(markers.nth(0)).toContainText(/Session compacted|Sesión compactada/)
  await expect(markers.nth(1)).toContainText(/Compacted automatically|Compactada automáticamente/)
  await expect(markers.nth(0)).toHaveAttribute("data-auto", "false")
  await expect(markers.nth(1)).toHaveAttribute("data-auto", "true")

  // The summary stays behind the toggle until it is asked for.
  await expect(markers.nth(0).locator(".fc-compaction-body")).toHaveCount(0)
  await markers.nth(0).locator(".fc-compaction-line").click()
  await expect(markers.nth(0).locator(".fc-compaction-body")).toContainText("A quedó hecha")
})

// A session that was compacted and not prompted again: the last thing the engine measured is the
// history it folded away, so the meter has no step to read the compacted session from.
const compacted = [
  user("u1", "Haz A y B", now),
  assistant("a1", "Hecha A.", now + 1, { input: 470_000, read: 4_000 }),
  compaction("c1", "manual", "## Resumen\n\n- A quedó hecha.", now + 10),
]

const contextTokens = (page: Page) => page.locator(".fc-aside-section").first().locator(".fc-aside-row span").first()

test("the meter sizes the session the compaction left, not the history it folded", async ({ page }) => {
  await openSession(page, compacted)

  await expect(contextTokens(page)).toContainText("~")
  await expect(contextTokens(page)).toHaveAttribute("title", /Estimated|Estimado/)
  // 474.0k was the request that wrote the summary; it is not what the next prompt will send.
  await expect(contextTokens(page)).not.toContainText("474")
})

test("a step after the compaction measures the session again", async ({ page }) => {
  await openSession(page, [...compacted, assistant("a2", "Voy.", now + 20, { input: 10_000, read: 11_000 })])

  await expect(contextTokens(page)).toContainText("21.0k")
  await expect(contextTokens(page)).not.toContainText("~")
})
