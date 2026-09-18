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

const workflow = {
  name: "feature",
  description: "Plan a feature, build it, and check it still works",
  inputs: ["goal"],
  tasks: [
    { id: "plan", kind: "agent", agent: "plan", gate: "human" },
    { id: "build", kind: "agent", agent: "build", dependsOn: ["plan"] },
    { id: "verify", kind: "verify", dependsOn: ["build"] },
  ],
}

const source = `name: feature
description: Plan a feature, build it, and check it still works
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    gate: human
    prompt: "Plan {{goal}}"
  - id: build
    agent: build
    dependsOn: [plan]
    prompt: "Do it"
  - id: verify
    kind: verify
    dependsOn: [build]
`

async function open(page: Page, onSave: (body: unknown) => void, onDelete: () => void) {
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
    const method = route.request().method()
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/workflows" && method === "GET")
      return route.fulfill({ json: { data: [workflow] } })
    if (url.pathname === "/harness/workflows/feature" && method === "GET")
      return route.fulfill({
        json: { data: { name: "feature", scope: "project", path: "/work/demo/.flupcode/workflows/feature.yaml", source, workflow } },
      })
    if (url.pathname === "/harness/workflows/feature" && method === "PUT") {
      onSave(route.request().postDataJSON())
      return route.fulfill({
        json: { data: { name: "feature", scope: "project", path: "/work/demo/.flupcode/workflows/feature.yaml", source, workflow } },
      })
    }
    if (url.pathname === "/harness/workflows/feature" && method === "DELETE") {
      onDelete()
      return route.fulfill({ json: { data: true } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/workflows")
}

test("a workflow is read as a file, drawn as a graph, and saved back", async ({ page }) => {
  let saved: unknown
  await open(page, (body) => (saved = body), () => undefined)

  // The one this project has, named with what it is for.
  const row = page.locator(".fc-workflow-row").filter({ hasText: "feature" })
  await expect(row).toBeVisible()
  await row.click()

  // The graph is the dependency shape, not a list: three nodes, two edges.
  const graph = page.locator(".fc-workflow-graph")
  await expect(graph.locator(".fc-workflow-node")).toHaveCount(3)
  await expect(graph.locator(".fc-workflow-edge")).toHaveCount(2)

  // The file as written is what is edited, not a form derived from it.
  const editor = page.getByLabel(/Workflow source|Fuente del flujo/)
  await expect(editor).toHaveValue(/dependsOn: \[plan\]/)
  await editor.fill(`${source}  - id: report\n    when:\n      task: verify\n      is: failed\n    prompt: say what broke\n`)
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect.poll(() => (saved as { source?: string })?.source).toContain("id: report")
  // The choice of where it is written travels with the save.
  expect(saved).toMatchObject({ scope: "project" })
})

test("deleting asks first and then removes the file", async ({ page }) => {
  let removed = 0
  await open(page, () => undefined, () => removed++)

  await page.locator(".fc-workflow-row").filter({ hasText: "feature" }).click()
  await page.getByRole("button", { name: /^Delete$|^Borrar$/ }).click()
  expect(removed).toBe(0)
  await expect(page.locator(".fc-confirm-inline")).toContainText("feature")
  await page.locator(".fc-confirm-inline").getByRole("button", { name: /^Delete$|^Borrar$/ }).click()
  await expect.poll(() => removed).toBe(1)
})
