import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_tasks",
  projectID: "p",
  title: "Tasks",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const message = {
  id: "msg_1",
  type: "assistant",
  time: { created: now },
  agent: "build",
  content: [{ type: "text", text: "Handing the library to a subagent" }],
  model: { providerID: "openai", id: "gpt" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const child = { ...session, id: "ses_child", parentID: "ses_tasks", title: "Analizar common-lib" }

/** `blockedChild` leaves the child waiting on a permission, which is work for the panel to watch. */
async function openSession(page: Page, options: { blockedChild?: boolean; idle?: boolean } = {}) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_tasks"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    // A session's children are the session list filtered by parent.
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_tasks")
      return route.fulfill({ json: { data: options.idle ? [] : [child], cursor: {} } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session, child], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_tasks/message")
      return route.fulfill({ json: { data: [message], cursor: {} } })
    if (url.pathname === "/api/permission/request")
      return route.fulfill({
        json: {
          data: options.blockedChild
            ? [{ id: "perm_1", sessionID: "ses_child", action: "edit", resources: ["src/index.ts"] }]
            : [],
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("this session's subagents sit in the panel", async ({ page }) => {
  await openSession(page, { blockedChild: true })

  const aside = page.locator(".fc-rightaside")
  await expect(aside.locator(".fc-aside-title", { hasText: "Subagents" })).toBeVisible()
  // A list of siblings, not chips across the top of the transcript.
  await expect(aside.locator(".fc-subagent")).toHaveText(["Analizar common-lib"])
  await expect(page.locator(".fc-subagents")).toHaveCount(0)
  // OpenCode 2 has no todo list, so the panel has no tasks to show above them.
  await expect(aside.locator(".fc-aside-todo")).toHaveCount(0)

  // The child is a session in the engine's list, but it is not a project of its own in the sidebar.
  await expect(page.locator(".fc-sidebar .fc-session-row")).toHaveCount(1)

  // Its dot says it is waiting on the reader, without having to open it.
  await expect(aside.locator(".fc-subagent .fc-session-dot-blocked")).toHaveCount(1)
})

/**
 * The panel is for watching work, so it comes and goes with it: open while a child is being worked
 * on or waits on a permission, closed when there is nothing to watch, and left alone the moment the
 * reader takes over.
 */
test("the panel opens itself while there is work to watch", async ({ page }) => {
  await openSession(page, { blockedChild: true })

  // Nothing was clicked: the child waiting on a permission is why it is there.
  await expect(page.locator(".fc-rightaside")).toBeVisible()
  await expect(page.locator(".fc-subagent")).toHaveCount(1)

  // A reader who closes it is not fought by the next render.
  await page.getByRole("button", { name: /Toggle details panel|Alternar panel de detalles/ }).click()
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})

test("a session with no work leaves the panel closed", async ({ page }) => {
  await openSession(page, { idle: true })

  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})
