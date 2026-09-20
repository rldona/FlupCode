import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_x",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const run = {
  id: "run_1",
  source: { type: "manual" },
  status: "running",
  startedAt: now,
  sessionID: "ses_root",
}

const tasks = [
  { id: "t1", runID: "run_1", position: 0, name: "plan it", prompt: "p", status: "success", startedAt: now, finishedAt: now + 4000, agent: "plan", sessionID: "ses_a" },
  { id: "t2", runID: "run_1", position: 1, name: "build it", prompt: "b", status: "running", startedAt: now + 4000 },
]

// The supervisor reads the list once and follows the stream after that. A task that changes while
// someone is looking must move on screen without the list being asked for again — that is the whole
// difference between this and the five-second poll it replaced.
test("a run and its tasks are shown, and a task moves when the server says so", async ({ page }) => {
  let listReads = 0

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
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") {
      listReads++
      return route.fulfill({ json: { data: [run] } })
    }
    if (url.pathname === "/harness/runs/run_1/tasks") return route.fulfill({ json: { data: tasks } })
    if (url.pathname === "/harness/events") {
      // Held open after one event: the second task finishes while the reader is watching.
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body:
          `id: 1\ndata: ${JSON.stringify({
            type: "task.changed",
            task: { ...tasks[1], status: "success", finishedAt: now + 9000, tokens: 2400, cost: 0.12 },
          })}\n\n`,
      })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // The nav item carries an icon in its label, so the name is matched loosely.
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const run1 = page.locator(".fc-run-card")
  await expect(run1).toHaveCount(1)
  await expect(run1.locator(".fc-run-task")).toHaveCount(2)
  await expect(run1.getByText("plan it")).toBeVisible()

  // The event moved it: the task shows what it cost, which only the event carried.
  const second = run1.locator(".fc-run-task").nth(1)
  await expect(second.locator(".fc-run-meta")).toContainText("2.4k", { timeout: 15_000 })
  await expect(second.locator(".fc-run-meta")).toContainText("$0.12")

  // The run's header adds its tasks up: the report of what it did, where there is room for it.
  await expect(run1.locator(".fc-run-head .fc-run-meta")).toContainText("2/2")
  await expect(run1.locator(".fc-run-head .fc-run-meta")).toContainText("2.4k")

  // And nothing was re-read to learn it.
  expect(listReads).toBeLessThanOrEqual(2)
})
