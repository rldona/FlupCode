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

const TODOS = [
  { content: "Reconociendo el código disponible", status: "completed" },
  { content: "Reconstruyendo comportamientos y arquitectura", status: "in_progress" },
  { content: "Redactando el informe forense", status: "pending" },
  { content: "Revisando trazabilidad y consistencia", status: "pending" },
]

/** The transcript's stale copy: the panel must show the engine's store, not this. */
const STALE = TODOS.map((todo) => ({ ...todo, status: "pending" }))

/**
 * The model's own `todowrite` call, in its stale form. `finished` marks the turn over: a task left
 * in progress then is one the model finished and never closed.
 */
const message = (finished: boolean) => ({
  id: "msg_1",
  sessionID: "ses_tasks",
  role: "assistant",
  type: "assistant",
  time: finished ? { created: now, completed: now } : { created: now },
  content: [{ type: "tool", name: "todowrite", id: "call_1", state: { status: "completed", input: { todos: STALE } } }],
  model: { providerID: "openai", modelID: "gpt" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const child = { ...session, id: "ses_child", parentID: "ses_tasks", title: "Analizar common-lib" }

async function openSession(page: Page, options: { blockedChild?: boolean; finished?: boolean } = {}) {
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session, child], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "feature", default_branch: "main" } })
    if (url.pathname === "/vcs/status") return route.fulfill({ json: [] })
    if (url.pathname === "/api/session/ses_tasks/message")
      return route.fulfill({ json: { data: [message(options.finished ?? false)], cursor: {} } })
    if (url.pathname === "/session/ses_tasks/children" || url.pathname === "/api/session/ses_tasks/children")
      return route.fulfill({ json: [child] })
    if (url.pathname === "/session/ses_tasks/todo" || url.pathname === "/api/session/ses_tasks/todo")
      return route.fulfill({ json: TODOS })
    if (url.pathname === "/permission")
      return route.fulfill({ json: options.blockedChild ? [{ id: "perm_1", sessionID: "ses_child" }] : [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("the task list is a timeline, and each disc carries its state", async ({ page }) => {
  await openSession(page)

  // The transcript's copy of the list says every task is pending; the engine's store says otherwise,
  // and it is the one the panel must believe.
  const items = page.locator(".fc-aside-todo")
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toHaveAttribute("data-status", "completed")
  await expect(items.nth(1)).toHaveAttribute("data-status", "in_progress")
  await expect(items.nth(3)).toHaveAttribute("data-status", "pending")

  // The state lives on the disc, not in the text: a completed task keeps its words, unstruck.
  await expect(items.nth(0).locator(".fc-aside-todo-mark")).toHaveText("✓")
  await expect(items.nth(3).locator(".fc-aside-todo-mark")).toHaveText("")
  await expect(items.nth(0)).not.toHaveCSS("text-decoration-line", "line-through")

  // Every task but the last draws the rail down to the one below it.
  const rail = await items.nth(0).evaluate((item) => getComputedStyle(item, "::before").content)
  expect(rail).not.toBe("none")
  const lastRail = await items.nth(3).evaluate((item) => getComputedStyle(item, "::before").content)
  expect(lastRail).toBe("none")
})

test("a task left in progress when the turn ends reads as done", async ({ page }) => {
  // Neither the engine's store nor the transcript ever recorded the final mark: the model finished
  // and never closed the list. With nothing running, what is left in progress is finished work.
  await openSession(page, { finished: true })

  const items = page.locator(".fc-aside-todo")
  await expect(items).toHaveCount(4)
  await expect(items.nth(1)).toHaveAttribute("data-status", "completed")
  await expect(items.nth(1).locator(".fc-aside-todo-mark")).toHaveText("✓")
  await expect(items.nth(3)).toHaveAttribute("data-status", "pending")
})

test("this session's subagents sit under the tasks, in the panel", async ({ page }) => {
  await openSession(page, { blockedChild: true })

  const aside = page.locator(".fc-rightaside")
  await expect(aside.locator(".fc-aside-title", { hasText: "Subagents" })).toBeVisible()
  // A list of siblings, not chips across the top of the transcript.
  await expect(aside.locator(".fc-subagent")).toHaveText(["Analizar common-lib"])
  await expect(page.locator(".fc-subagents")).toHaveCount(0)

  // The child is a session in the engine's list, but it is not a project of its own in the sidebar.
  await expect(page.locator(".fc-sidebar .fc-session-row")).toHaveCount(1)

  // Its dot says it is working, without having to open it.
  await expect(aside.locator(".fc-subagent .fc-session-dot-blocked")).toHaveCount(1)
})
