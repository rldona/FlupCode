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

async function open(page: Page, onSave: (body: unknown, name: string) => void, onDelete: () => void) {
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
    // Any other named workflow reads back as the file it was saved as.
    if (url.pathname.startsWith("/harness/workflows/") && method === "GET") {
      const name = decodeURIComponent(url.pathname.split("/").pop()!)
      return route.fulfill({
        json: {
          data: {
            name,
            scope: "project",
            path: `/work/demo/.flupcode/workflows/${name}.yaml`,
            source: `name: ${name}\ntasks:\n  - id: a\n    prompt: a\n`,
            workflow: { name, description: "", inputs: [], tasks: [{ id: "a" }] },
          },
        },
      })
    }
    // Any workflow can be written back, so the create dialog is exercised too.
    if (url.pathname.startsWith("/harness/workflows/") && method === "PUT") {
      const name = decodeURIComponent(url.pathname.split("/").pop()!)
      const body = route.request().postDataJSON() as { source: string; scope?: "project" | "global" }
      onSave(body, name)
      return route.fulfill({
        json: { data: { name, scope: body.scope ?? "project", path: `/work/demo/.flupcode/workflows/${name}.yaml`, source: body.source, workflow } },
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

// H-28: creating a workflow is a moment of its own, not a row in the list, so it is a dialog. The
// name field renames the file the dialog writes, without discarding the rest of the template.
test("a new workflow is created from a dialog, and its name reaches the file", async ({ page }) => {
  let saved: { name?: string; body?: { source?: string; scope?: string } } = {}
  await open(page, (body, name) => (saved = { name, body: body as never }), () => undefined)

  await page.getByRole("button", { name: "New workflow" }).click()
  const dialog = page.locator(".fc-workflow-modal")
  await expect(dialog).toBeVisible()

  await dialog.getByLabel("Name").fill("ship-it")
  await expect(dialog.getByLabel(/Workflow source|Fuente del flujo/)).toHaveValue(/name: ship-it/)
  await dialog.getByRole("button", { name: /^Create$|^Crear$/ }).click()

  await expect.poll(() => saved.name).toBe("ship-it")
  expect(saved.body?.source).toContain("name: ship-it")
  // The create dialog gives way to the file it wrote, open in the detail dialog.
  await expect(page.getByRole("dialog", { name: "ship-it" })).toBeVisible()
})

// H-28: a workflow with more than one input had nowhere to put the rest, and a run's packs,
// worktrees and policy were API-only. The launcher is where those selectors live.
test("a two-input workflow is launched from a dialog that carries packs, worktrees and a policy", async ({ page }) => {
  const deploy = {
    name: "deploy",
    description: "Ship it",
    inputs: ["env", "goal"],
    tasks: [{ id: "ship", kind: "agent", agent: "build" }],
  }
  let started: { name?: string; body?: unknown } = {}

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
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["packs"] } } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [deploy] } })
    if (url.pathname === "/harness/packs")
      return route.fulfill({ json: { data: [{ id: "p1", name: "notes", refs: [], createdAt: 0 }] } })
    if (url.pathname === "/harness/workflows/deploy/runs" && route.request().method() === "POST") {
      started = { name: "deploy", body: route.request().postDataJSON() }
      return route.fulfill({ json: { data: { id: "run_d", source: { type: "manual" }, status: "running", startedAt: 0 } } })
    }
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/")

  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill("/deploy staging")
  await input.press("Enter")

  const dialog = page.locator(".fc-launch-modal")
  await expect(dialog).toBeVisible()
  // What was typed after the name filled the first input; the second starts empty, and the dialog
  // will not launch until it is answered.
  await expect(dialog.getByPlaceholder("env")).toHaveValue("staging")
  const run = dialog.getByRole("button", { name: /^Run$|^Ejecutar$/ })
  await expect(run).toBeDisabled()

  await dialog.getByPlaceholder("goal").fill("ship the cache fix")
  await dialog.getByLabel(/worktree/i).check()
  await dialog.getByLabel("notes").check()
  await dialog.getByPlaceholder("provider/model").fill("a/backup")
  await expect(run).toBeEnabled()
  await run.click()

  await expect.poll(() => started.name).toBe("deploy")
  expect(started.body).toMatchObject({
    inputs: { env: "staging", goal: "ship the cache fix" },
    packs: ["notes"],
    worktrees: true,
    policy: { fallback: "a/backup" },
  })
  await expect(page).toHaveURL(/\/runs$/)
})
