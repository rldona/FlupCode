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

const models = [
  { id: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5" },
  { id: "gpt-5", providerID: "openai", name: "GPT-5" },
]

const runs = [
  { id: "run_a", source: { type: "manual" }, status: "success", startedAt: 0, finishedAt: 60_000 },
  { id: "run_b", source: { type: "manual" }, status: "success", startedAt: 0, finishedAt: 30_000 },
]

const tasks = {
  run_a: [
    {
      id: "a1",
      runID: "run_a",
      position: 0,
      name: "anthropic/claude-opus-5",
      prompt: "Do the thing",
      status: "success",
      tokens: 100,
      cost: 0.1,
    },
  ],
  run_b: [
    {
      id: "b1",
      runID: "run_b",
      position: 0,
      name: "openai/gpt-5",
      prompt: "Do the thing",
      status: "success",
      tokens: 250,
      cost: 0.25,
    },
  ],
}

async function open(page: Page, path: string) {
  const posts: Array<{ path: string; body: unknown }> = []
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
    if (url.pathname === "/api/model") return route.fulfill({ json: { data: models } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/runs" && route.request().method() === "GET")
      return route.fulfill({ json: { data: runs } })
    if (url.pathname === "/harness/best-of-n" && route.request().method() === "POST") {
      posts.push({ path: url.pathname, body: route.request().postDataJSON() })
      return route.fulfill({ status: 202, json: { data: runs } })
    }
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
  await page.goto(path)
  return posts
}

const row = (page: Page, label: string) =>
  page.locator(".fc-compare-table tr").filter({ has: page.locator("th", { hasText: label }) })

// A best-of-n lands on a comparison link (H-44), so the batch it was run for survives a reload and
// the reader does not have to pick the two runs again.
test("a comparison link opens with its pair already picked", async ({ page }) => {
  await open(page, "/compare?left=run_a&right=run_b")

  await expect(row(page, "Tokens")).toContainText("100")
  await expect(row(page, "Tokens")).toContainText("250")
  await expect(row(page, "Tokens")).toContainText("+150")
})

// One task, several models (H-44): each model gets its own run, named after it, and the comparison
// opens with the first two already chosen.
test("best of n runs the same task once per model and opens the comparison", async ({ page }) => {
  const posts = await open(page, "/runs")

  await page.getByRole("button", { name: "Best of N" }).click()
  const dialog = page.getByRole("dialog", { name: "Best of N" })
  await dialog.locator("textarea").fill("Do the thing")

  const checkboxes = dialog.locator(".fc-model-picker input[type=checkbox]")
  await checkboxes.nth(0).check()
  await checkboxes.nth(1).check()
  await dialog.getByRole("button", { name: "Run" }).click()

  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0]!.body).toMatchObject({
    prompt: "Do the thing",
    models: ["anthropic/claude-opus-5", "openai/gpt-5"],
  })

  await expect(page).toHaveURL(/left=run_a&right=run_b/)
  await expect(row(page, "Tokens")).toContainText("+150")
  // And the pickers say which pair was chosen, not just the table.
  await expect(page.locator(".fc-compare-pickers select").first()).toHaveValue("run_a")
  await expect(page.locator(".fc-compare-pickers select").nth(1)).toHaveValue("run_b")
})
