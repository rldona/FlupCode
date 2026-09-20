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

const runs = [
  { id: "run_a", source: { type: "manual" }, status: "success", startedAt: 0, finishedAt: 60_000 },
  { id: "run_b", source: { type: "manual" }, status: "success", startedAt: 0, finishedAt: 30_000 },
]

const tasks = {
  run_a: [{ id: "a1", runID: "run_a", position: 0, name: "build", prompt: "b", status: "success", tokens: 100, cost: 0.1 }],
  run_b: [
    { id: "b1", runID: "run_b", position: 0, name: "build", prompt: "b", status: "success", tokens: 250, cost: 0.25 },
    { id: "b2", runID: "run_b", position: 1, name: "verify", prompt: "", kind: "verify", status: "failed", error: "Verification failed: test" },
  ],
}

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
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: runs } })
    const detail = /^\/harness\/runs\/([^/]+)(\/(tasks|files))?$/.exec(url.pathname)
    if (detail) {
      const id = detail[1]!
      if (detail[3] === "tasks") return route.fulfill({ json: { data: tasks[id as "run_a" | "run_b"] ?? [] } })
      if (detail[3] === "files") return route.fulfill({ json: { data: [] } })
      return route.fulfill({ json: { data: runs.find((entry) => entry.id === id) } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/compare")
}

test("two runs are compared by tokens, cost, duration and verdict", async ({ page }) => {
  await open(page)

  // It is a tool screen like the rest: in the main column, with the sidebar still there.
  await expect(page.locator(".fc-sidebar")).toBeVisible()
  await expect(page.locator(".fc-main .fc-routines-screen")).toBeVisible()

  const pickers = page.locator(".fc-compare-pickers select")
  await pickers.nth(0).selectOption("run_a")
  await pickers.nth(1).selectOption("run_b")

  const table = page.locator(".fc-compare-table")
  const row = (label: string) => table.locator("tr").filter({ has: page.locator("th", { hasText: label }) })

  await expect(row("Tokens")).toContainText("100")
  await expect(row("Tokens")).toContainText("250")
  await expect(row("Tokens")).toContainText("+150")
  // The shorter run reads as a negative difference against the first.
  await expect(row("Duration")).toContainText("−30s")
  // And the failing check is named, not just counted.
  await expect(row("Verdict")).toContainText("failed")
  await expect(row("Verdict")).toContainText("Verification failed: test")
})
