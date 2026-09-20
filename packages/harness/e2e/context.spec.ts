import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_c",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 12_000, output: 3_000, reasoning: 800, cache: { read: 40_000, write: 2_000 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const report = {
  directory: "/work/demo",
  projectDirectory: "/work/demo",
  instructions: [
    { path: "/home/dev/.config/opencode/AGENTS.md", scope: "global", bytes: 219, excerpt: "Deployments" },
    { path: "/work/demo/AGENTS.md", scope: "project", bytes: 9141, excerpt: "Use tabs, not spaces." },
  ],
}

type Options = { report?: unknown; tools?: string[]; skills?: unknown[]; mcp?: unknown; prompts?: unknown[] }

async function open(page: Page, options: Options = {}) {
  let reads = 0
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_c"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/context") return route.fulfill({ json: { data: options.report ?? report } })
    if (url.pathname === "/harness/context/system-prompt")
      return route.fulfill({ json: { data: options.prompts ?? [] } })
    if (url.pathname === "/harness/context/file") {
      reads++
      return route.fulfill({ json: { data: { content: "# Project\nUse tabs, not spaces.\n" } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/experimental/tool/ids")
      return route.fulfill({ json: options.tools ?? ["bash", "read", "edit", "glob"] })
    if (url.pathname === "/api/skill")
      return route.fulfill({
        json: { data: options.skills ?? [{ name: "effect", description: "Work with Effect v4 in this repo" }] },
      })
    if (url.pathname === "/mcp") return route.fulfill({ json: options.mcp ?? {} })
    if (url.pathname === "/api/agent")
      return route.fulfill({
        json: { data: [{ id: "build", description: "The default agent.", mode: "primary" }] },
      })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/context")
  await expect(page.locator(".fc-context-screen")).toBeVisible()
  return { reads: () => reads }
}

test("lists the instruction files a turn here would load, nearest last", async ({ page }) => {
  await open(page)

  const rows = page.locator(".fc-context-row")
  await expect(rows).toHaveCount(2)
  // The global one first, the project's after it: the nearest file has the last word.
  await expect(rows.nth(0)).toContainText("opencode/AGENTS.md")
  await expect(rows.nth(1)).toContainText("demo/AGENTS.md")
  await expect(rows.nth(1)).toContainText("Use tabs, not spaces.")
})

test("says what the instructions cost, because that is the part nobody sees", async ({ page }) => {
  await open(page)
  // 9,360 bytes together. The estimate is labelled as one.
  await expect(page.locator(".fc-usage-block").first()).toContainText("9.1 kB")
  await expect(page.locator(".fc-usage-block").first()).toContainText(/about 2\.3k|unos 2\.3k/)
})

test("a file opens where it is, and only when asked", async ({ page }) => {
  const { reads } = await open(page)
  expect(reads()).toBe(0)

  await page.locator(".fc-context-row").nth(1).click()

  await expect.poll(() => reads()).toBe(1)
  await expect(page.locator(".fc-context-file pre")).toContainText("Use tabs, not spaces.")
})

test("nothing loaded says so, rather than leaving an empty heading", async ({ page }) => {
  await open(page, { report: { directory: "/work/demo", instructions: [] } })

  await expect(page.getByText(/starts with your prompt alone|empieza sólo con tu prompt/)).toBeVisible()
  await expect(page.locator(".fc-context-row")).toHaveCount(0)
})

test("a reason for loading nothing is shown as a reason", async ({ page }) => {
  await open(page, {
    report: {
      directory: "/elsewhere",
      instructions: [],
      problem: "This folder is outside the project, so nothing from the project is loaded",
    },
  })

  await expect(page.getByText(/outside the project/)).toBeVisible()
})

test("shows the skills and the tools the model is offered", async ({ page }) => {
  await open(page)

  await expect(page.locator(".fc-usage-block").filter({ hasText: "Skills" })).toContainText("effect")
  const tools = page.locator(".fc-context-chip")
  await expect(tools).toHaveCount(4)
  await expect(tools.first()).toHaveText("bash")
})

test("an MCP server that is not answering is not drawn as one that is", async ({ page }) => {
  await open(page, { mcp: { docs: { status: "connected" }, linear: { status: "failed" } } })

  const block = page.locator(".fc-usage-block").filter({ hasText: "Tools" })
  await expect(block).toContainText(/1 of 2|1 de 2/)
  await expect(block.locator(".fc-context-chip-off")).toHaveText("linear")
})

test("breaks this session's tokens into the five the engine reports", async ({ page }) => {
  await open(page)

  const block = page.locator(".fc-usage-block").filter({ hasText: /This session's tokens|Tokens de esta/ })
  await expect(block).toContainText("12.0k")
  await expect(block).toContainText("40.0k")
  // Reasoning and both cache figures too: five categories, which is all the engine reports.
  await expect(block.locator(".fc-usage-row")).toHaveCount(5)
})

test("shows the system prompt the engine actually sent", async ({ page }) => {
  await open(page, {
    prompts: [
      {
        at: now,
        providerID: "deepseek",
        modelID: "flash",
        system: ["You are opencode.\n\nInstructions from: /work/demo/AGENTS.md\n\nUse tabs, not spaces."],
      },
      // A title is a request too, and a small one. Both are listed rather than the newest winning.
      { at: now - 60_000, providerID: "deepseek", modelID: "flash", system: ["You generate a title."] },
    ],
  })

  const block = page.locator(".fc-usage-block").filter({ hasText: /The system prompt|El system prompt/ })
  const rows = block.locator(".fc-context-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("deepseek/flash")

  // Listed, not poured out: the prompt is behind the row.
  await expect(block.locator(".fc-pr-log")).toHaveCount(0)
  await rows.nth(0).click()
  await expect(block.locator(".fc-pr-log")).toContainText("Instructions from: /work/demo/AGENTS.md")
})

test("nothing recorded says so, and says when it will be", async ({ page }) => {
  await open(page, { prompts: [] })

  const block = page.locator(".fc-usage-block").filter({ hasText: /The system prompt|El system prompt/ })
  await expect(block).toContainText(/Nothing recorded yet|Todavía no hay nada grabado/)
  await expect(block).toContainText(/restart|reiniciarse/)
  // The agents are listed either way: their own prompt is part of the system prompt.
  await expect(block).toContainText("build")
})
