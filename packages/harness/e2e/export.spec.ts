import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_exp",
  projectID: "p",
  title: "Export",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// OpenCode 2 pages a transcript newest first.
const messages = [
  {
    id: "a",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt" },
    time: { created: now + 1, completed: now + 3 },
    content: [
      { type: "reasoning", text: "Think about the reducer" },
      { type: "text", text: "Here is the plan." },
    ],
  },
  { id: "u", type: "user", text: "Plan it", time: { created: now } },
]

async function open(page: Page) {
  const shares: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_exp"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["shares"] } } })
    if (url.pathname === "/harness/shares" && route.request().method() === "POST") {
      shares.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { data: { id: "sh_1", title: "Export", url: "/harness/shares/sh_1" } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_exp/message") return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-transcript-body")).toBeVisible()
  return { shares }
}

test("the export dialog writes the conversation as markdown with the options chosen", async ({ page }) => {
  await open(page)
  await page.getByRole("button", { name: "Menu", exact: true }).first().click()
  await page.getByText("Export MD", { exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Export conversation" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Include the thinking")).toBeChecked()
  await expect(dialog.getByLabel("Include tool output")).not.toBeChecked()

  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download Markdown" }).click()])
  expect(download.suggestedFilename()).toBe("ses_exp.md")
  const path = await download.path()
  const text = readFileSync(path!, "utf8")
  expect(text).toContain("# Export")
  expect(text).toContain("## User")
  expect(text).toContain("Here is the plan.")
  expect(text).toContain("<summary>Reasoning</summary>")
})

test("the harness keeps a copy and the link is copied", async ({ page }) => {
  const api = await open(page)
  await page.getByRole("button", { name: "Menu", exact: true }).first().click()
  await page.getByText("Export MD", { exact: true }).click()

  await page.getByRole("dialog", { name: "Export conversation" }).getByRole("button", { name: "Copy link" }).click()

  await expect.poll(() => api.shares).toHaveLength(1)
  expect(api.shares[0]!.markdown).toContain("Here is the plan.")
})
