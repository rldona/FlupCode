import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_tools",
  projectID: "p",
  title: "Tools",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const child = { ...session, id: "ses_child", parentID: "ses_tools", title: "Analizar common-lib" }

const tool = (name: string, input: Record<string, unknown>, text: string) => ({
  type: "tool",
  name,
  id: `call_${name}`,
  state: { status: "completed", input, content: [{ type: "text", text }] },
  time: { created: now, completed: now },
})

const message = {
  id: "msg_1",
  sessionID: "ses_tools",
  role: "assistant",
  type: "assistant",
  time: { created: now, completed: now },
  content: [
    tool("todowrite", { todos: [
      { content: "Read the file", status: "completed" },
      { content: "Search the repo", status: "in_progress" },
      { content: "Open the subagent", status: "pending" },
    ] }, "ok"),
    tool("glob", { pattern: "src/**/*.ts" }, "src/a.ts\nsrc/b.ts\nsrc/c.ts"),
    tool("read", { filePath: "src/a.ts" }, "export const a = 1\nexport const b = 2"),
    tool("task", { description: "Analizar common-lib", prompt: "look" }, '<task id="ses_child" state="completed">done</task>'),
    tool("webfetch", { url: "https://example.com/docs" }, "Some fetched text"),
  ],
  model: { providerID: "openai", modelID: "gpt" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

async function open(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_tools"))
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
    if (url.pathname === "/api/session/ses_tools/message")
      return route.fulfill({ json: { data: [message], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(children|todo|permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.locator(".fc-toolgroup-line").click()
}

const toolCard = (page: Page, name: string) =>
  page.locator(".fc-tool", { has: page.locator(".fc-tool-name", { hasText: new RegExp(`^${name}$`) }) })

test("each tool draws its own result, not a wall of text", async ({ page }) => {
  await open(page)

  // A todo call is the list it wrote.
  const todos = toolCard(page, "todowrite")
  await todos.locator(".fc-tool-header").click()
  await expect(todos.locator(".fc-tool-todo")).toHaveCount(3)
  await expect(todos.locator(".fc-tool-todo").nth(1)).toHaveAttribute("data-status", "in_progress")
  await expect(todos.locator(".fc-tool-todo").nth(0).locator(".fc-tool-todo-mark")).toHaveText("✓")

  // A glob result is a list of paths.
  const glob = toolCard(page, "glob")
  await glob.locator(".fc-tool-header").click()
  await expect(glob.locator(".fc-tool-list-item")).toHaveCount(3)

  // A read is the file's content, highlighted.
  const read = toolCard(page, "read")
  await read.locator(".fc-tool-header").click()
  await expect(read.locator(".fc-tool-read")).toContainText("export const a")

  // A fetch shows the link it went to.
  const fetch = toolCard(page, "webfetch")
  await fetch.locator(".fc-tool-header").click()
  await expect(fetch.locator(".fc-tool-link")).toHaveAttribute("href", "https://example.com/docs")
})

test("a task call offers a way into the child session it ran in", async ({ page }) => {
  await open(page)

  const task = toolCard(page, "task")
  await task.locator(".fc-tool-header").click()
  await task.locator(".fc-tool-open").click()

  // Opening it selects the child, so the top bar now names it.
  await expect(page.locator(".fc-session-heading-title")).toContainText("Analizar common-lib")
})
