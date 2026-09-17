import { expect, test, type Page } from "@playwright/test"

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

const run = { id: "run_1", source: { type: "manual" }, status: "running", startedAt: now, directory: "/work/demo" }

const tasks = [
  {
    id: "t1",
    runID: "run_1",
    position: 0,
    name: "plan it",
    prompt: "p",
    status: "success",
    startedAt: now,
    finishedAt: now + 4000,
    agent: "plan",
  },
  { id: "t2", runID: "run_1", position: 1, name: "build it", prompt: "b", status: "running", startedAt: now + 4000, sessionID: "ses_b" },
]

const files = [
  { taskID: "t1", checkpointID: "cp1", title: "plan it", files: [{ path: "PLAN.md", status: "added" }] },
]

type Options = { activity?: unknown[]; files?: unknown[]; run?: Record<string, unknown>; tasks?: unknown[] }

async function open(page: Page, options: Options = {}) {
  let activityReads = 0
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
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [{ ...run, ...options.run }] } })
    if (url.pathname === "/harness/runs/run_1/tasks")
      return route.fulfill({ json: { data: options.tasks ?? tasks } })
    if (url.pathname === "/harness/runs/run_1/activity") {
      activityReads++
      return route.fulfill({ json: { data: options.activity ?? [] } })
    }
    if (url.pathname === "/harness/runs/run_1/files") return route.fulfill({ json: { data: options.files ?? files } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/runs")
  await expect(page.getByText("build it")).toBeVisible()
  return { reads: () => activityReads }
}

test("a running task says which tool it is inside, and for how long", async ({ page }) => {
  await open(page, {
    activity: [{ taskID: "t2", tool: "glob", detail: "project.yaml", waitingMs: 21_000 }],
  })

  const doing = page.locator(".fc-run-doing")
  await expect(doing).toContainText("glob")
  await expect(doing).toContainText("project.yaml")
  await expect(doing).toContainText("21s")
})

test("a call that has gone on too long stops looking like work", async ({ page }) => {
  await open(page, {
    // H-47: eighteen minutes inside one `glob`, indistinguishable from progress.
    activity: [{ taskID: "t2", tool: "glob", detail: "project.yaml", waitingMs: 18 * 60_000 }],
  })

  await expect(page.locator(".fc-run-doing")).toHaveClass(/fc-run-doing-long/)
  await expect(page.locator(".fc-run-doing")).toContainText("18m")
})

test("a short call is not marked as a problem", async ({ page }) => {
  await open(page, { activity: [{ taskID: "t2", tool: "bash", detail: "bun test", waitingMs: 9_000 }] })

  await expect(page.locator(".fc-run-doing")).not.toHaveClass(/fc-run-doing-long/)
})

test("without the tool's name it still says how long it has been waiting", async ({ page }) => {
  // The engine cannot always say what a turn is inside. Saying nothing would be worse than saying
  // how long it has been.
  await open(page, { activity: [{ taskID: "t2", waitingMs: 30_000 }] })

  await expect(page.locator(".fc-run-doing")).toContainText(/working|trabajando/)
  await expect(page.locator(".fc-run-doing")).toContainText("30s")
})

test("it keeps asking while something is running", async ({ page }) => {
  const { reads } = await open(page, { activity: [{ taskID: "t2", tool: "bash", waitingMs: 1000 }] })

  const first = reads()
  await expect.poll(() => reads(), { timeout: 10_000 }).toBeGreaterThan(first)
})

test("a finished task lists what it changed on disk", async ({ page }) => {
  await open(page)

  const changed = page.locator(".fc-run-files")
  await expect(changed).toContainText(/1 files|1 archivos/)
  await changed.click()
  await expect(changed).toContainText("PLAN.md")
})

test("a task that changed nothing says so, rather than showing nothing", async ({ page }) => {
  await open(page, { files: [{ taskID: "t1", checkpointID: "cp1", title: "plan it", files: [] }] })

  await expect(page.getByText(/Changed no files|No cambió ningún archivo/)).toBeVisible()
  await expect(page.locator(".fc-run-files")).toHaveCount(0)
})

test("a task with no checkpoint shows neither, rather than an empty claim", async ({ page }) => {
  // A folder that is not a repository has no checkpoints, so there is nothing to say about files.
  await open(page, { files: [] })

  await expect(page.locator(".fc-run-files")).toHaveCount(0)
  await expect(page.getByText(/Changed no files|No cambió ningún archivo/)).toHaveCount(0)
})

test("a run that was allowed outside its project says so", async ({ page }) => {
  // H-47. Confinement is the default and says nothing; the exception is the thing worth reading.
  await open(page, { run: { outside: true, toolLimitMs: 10 * 60_000 } })

  await expect(page.locator(".fc-run-rule-open")).toContainText(/Reaches outside|Sale del proyecto/)
  await expect(page.locator(".fc-run-rules")).toContainText("10")
})

test("a confined run adds nothing to the screen", async ({ page }) => {
  await open(page)
  await expect(page.locator(".fc-run-rules")).toHaveCount(0)
})

test("a task stopped by the ceiling says what was running and for how long", async ({ page }) => {
  await open(page, {
    run: { toolLimitMs: 10 * 60_000 },
    tasks: [
      {
        id: "t9",
        runID: "run_1",
        position: 0,
        name: "build it",
        prompt: "b",
        status: "failed",
        error: "`glob` ran for 20 minutes, over this run's limit of 10 for a single tool call",
        startedAt: now,
        finishedAt: now + 1,
      },
    ],
  })

  await expect(page.locator(".fc-run-error")).toContainText("`glob` ran for 20 minutes")
})
