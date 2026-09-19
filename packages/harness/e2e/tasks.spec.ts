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

async function openSession(page: Page, options: { blockedChild?: boolean; finished?: boolean; idle?: boolean } = {}) {
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
      return route.fulfill({ json: options.idle ? [] : [child] })
    if (url.pathname === "/session/ses_tasks/todo" || url.pathname === "/api/session/ses_tasks/todo")
      return route.fulfill({ json: options.idle ? [] : TODOS })
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

/**
 * The panel is for watching work, so it comes and goes with it: open while there is a task left or a
 * child being worked on, closed when there is nothing to watch, and left alone the moment the reader
 * takes over.
 */
test("the panel opens itself while there is work to watch", async ({ page }) => {
  await openSession(page)

  // Nothing was clicked: the task list is why it is there.
  await expect(page.locator(".fc-rightaside")).toBeVisible()
  await expect(page.locator(".fc-aside-todo")).toHaveCount(4)

  // A reader who closes it is not fought by the next render.
  await page.getByRole("button", { name: /Toggle context panel|Alternar panel de contexto/ }).click()
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})

test("a session with no work leaves the panel closed", async ({ page }) => {
  await openSession(page, { idle: true })

  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})

test("clear all takes the tasks the engine never finished", async ({ page }) => {
  await openSession(page)

  const items = page.locator(".fc-aside-todo")
  await expect(items).toHaveCount(4)

  // One is completed and three are not; "Clear completed" could not touch those three.
  await page.getByRole("button", { name: /^Clear all$|^Borrar todo$/ }).click()

  await expect(items).toHaveCount(0)
})

/**
 * The resources behind the panel hold the last session's value while the open one loads. Read as the
 * open session's, they offered the panel for work that belonged to the session left behind, which is
 * the flash of it a reader saw right after switching.
 */
test("switching to an idle session never flashes the panel the last one opened", async ({ page }) => {
  const other = { ...session, id: "ses_other", title: "Other" }
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
  const slow = () => new Promise((resolve) => setTimeout(resolve, 500))
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session, other], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_tasks/message")
      return route.fulfill({ json: { data: [message(false)], cursor: {} } })
    if (url.pathname === "/session/ses_tasks/children" || url.pathname === "/api/session/ses_tasks/children")
      return route.fulfill({ json: [] })
    if (url.pathname === "/session/ses_tasks/todo" || url.pathname === "/api/session/ses_tasks/todo")
      return route.fulfill({ json: TODOS })
    // The session being opened answers late, so a panel driven by the one left behind has time to
    // show itself before its own empty context lands.
    if (url.pathname === "/api/session/ses_other/message") {
      await slow()
      return route.fulfill({ json: { data: [], cursor: {} } })
    }
    if (url.pathname === "/session/ses_other/children" || url.pathname === "/api/session/ses_other/children") {
      await slow()
      return route.fulfill({ json: [] })
    }
    if (url.pathname === "/session/ses_other/todo" || url.pathname === "/api/session/ses_other/todo") {
      await slow()
      return route.fulfill({ json: [] })
    }
    if (url.pathname === "/permission") return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-rightaside")).toBeVisible()

  // Clearing the tasks leaves the panel closed on this session.
  await page.getByRole("button", { name: /^Clear all$|^Borrar todo$/ }).click()
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)

  // Watch for the panel reappearing while the next session loads its own, empty context.
  await page.evaluate(() => {
    ;(window as unknown as { flashed: boolean }).flashed = false
    new MutationObserver(() => {
      if (document.querySelector(".fc-rightaside")) (window as unknown as { flashed: boolean }).flashed = true
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.locator(".fc-session-row", { hasText: "Other" }).click()
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => (window as unknown as { flashed: boolean }).flashed)).toBe(false)
})
