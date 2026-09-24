import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_a",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const reviewer = {
  name: "reviewer",
  path: "/work/demo/.opencode/agent/reviewer.md",
  scope: "project",
  root: "/work/demo/.opencode",
  fields: { description: "Reviews a diff", mode: "subagent", model: "anthropic/claude", tools: { "*": false } },
  prompt: "Review the diff and say what is wrong.",
  bytes: 210,
}

type Options = { files?: unknown[]; agents?: unknown[] }

async function open(page: Page, options: Options = {}) {
  const saved: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const reloads: Array<string | null> = []
  const agentListReads: Array<string | null> = []
  // One timeline of the calls that matter, so a test can say the reload came before the list.
  const calls: string[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_a"))
  })
  await page.route("http://127.0.0.1:9097/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/agents" && route.request().method() === "POST") {
      saved.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>)
      return route.fulfill({ json: { data: { path: "/work/demo/.opencode/agent/new.md" } } })
    }
    if (url.pathname === "/harness/agents" && route.request().method() === "DELETE") {
      deleted.push(url.searchParams.get("path") ?? "")
      return route.fulfill({ json: { data: { removed: true } } })
    }
    if (url.pathname === "/harness/agents") return route.fulfill({ json: { data: options.files ?? [reviewer] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/experimental/tool/ids") return route.fulfill({ json: ["bash", "read", "edit"] })
    // The screen asks the legacy `/agent?directory=`, which is the only one that answers per folder.
    // `/api/agent` is here too, answering something different on purpose: if the screen read that
    // one, this fixture would show it.
    if (url.pathname === "/agent")
      return route.fulfill({
        json: options.agents ?? [
          { name: "build", description: "The default agent.", mode: "primary" },
          { name: "reviewer", description: "Reviews a diff", mode: "subagent" },
        ],
      })
    if (url.pathname === "/api/agent") {
      const directory = url.searchParams.get("location[directory]")
      agentListReads.push(directory)
      calls.push(`agent:${directory}`)
      return route.fulfill({ json: { data: [{ id: "somewhere-else", description: "Another folder's" }] } })
    }
    if (url.pathname === "/config/reload" && route.request().method() === "POST") {
      const directory = url.searchParams.get("directory")
      reloads.push(directory)
      calls.push(`reload:${directory}`)
      return route.fulfill({ json: true })
    }
    if (url.pathname === "/mcp") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  // Agents live in Settings now, not on a screen of their own (CU-1).
  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  const dialog = page.getByRole("dialog", { name: "Customize" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: /^Agents$/ }).click()
  await expect(dialog.getByRole("heading", { name: /^Agents$|^Agentes$/ })).toBeVisible()
  return {
    saved: () => saved,
    deleted: () => deleted,
    reloads: () => reloads,
    agentListReads: () => agentListReads,
    calls: () => calls,
  }
}

test("lists the agent files, with where each one lives", async ({ page }) => {
  await open(page)

  const row = page.locator(".fc-agent-row")
  await expect(row).toHaveCount(1)
  await expect(row).toContainText("reviewer")
  await expect(row).toContainText("Reviews a diff")
  await expect(row).toContainText(/project|proyecto/)
})

test("opens one into a form with what the file says", async ({ page }) => {
  await open(page, {
    files: [{ ...reviewer, fields: { ...reviewer.fields, tools: { bash: false, read: true } } }],
  })
  await page.locator(".fc-agent-row").click()

  // The editor is a dialog whose body scrolls under a fixed header and above fixed actions.
  await expect(page.locator(".fc-form-modal .fc-modal-body")).toBeVisible()
  await expect(page.locator(".fc-agent-prompt")).toHaveValue("Review the diff and say what is wrong.")
  await expect(page.locator(".fc-agent-form")).toContainText("/work/demo/.opencode/agent/reviewer.md")
  // The tools the file set are drawn as it set them, and the one it said nothing about is unset.
  await expect(page.locator(".fc-agent-tool", { hasText: "bash" })).toHaveAttribute("data-state", "off")
  await expect(page.locator(".fc-agent-tool", { hasText: "read" })).toHaveAttribute("data-state", "on")
  await expect(page.locator(".fc-agent-tool", { hasText: "edit" })).toHaveAttribute("data-state", "unset")
})

test("saving sends the file back, keeping what the form does not draw", async ({ page }) => {
  const { saved } = await open(page, {
    files: [{ ...reviewer, fields: { ...reviewer.fields, top_p: 0.9 } }],
  })
  await page.locator(".fc-agent-row").click()
  await page.locator(".fc-agent-prompt").fill("Review it harder.")
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect.poll(() => saved().length).toBe(1)
  const body = saved()[0]!
  expect(body.name).toBe("reviewer")
  expect(body.prompt).toBe("Review it harder.")
  // The file it was opened from, so the write goes back to it rather than to a new one.
  expect(body.path).toBe("/work/demo/.opencode/agent/reviewer.md")
  // `top_p` is not a field this form has. An editor that dropped it would be eating work.
  expect((body.fields as Record<string, unknown>).top_p).toBe(0.9)
  expect((body.fields as Record<string, unknown>).description).toBe("Reviews a diff")
  // A save is done: the dialog closes instead of staying open.
  await expect(page.locator(".fc-agent-form")).toBeHidden()
})

test("saving an agent reloads the engine's definitions and re-reads the lists", async ({ page }) => {
  const { reloads, agentListReads, calls } = await open(page)
  const readsBefore = agentListReads().length

  await page.getByRole("button", { name: /New agent|Nuevo agente/ }).click()
  await page.locator(".fc-agent-form").getByLabel(/^Name$|^Nombre$/).fill("scout")
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  // The reload names the folder the panel wrote into, and the engine's agent list is asked again.
  await expect.poll(() => reloads()).toEqual(["/work/demo"])
  await expect.poll(() => agentListReads().length).toBeGreaterThan(readsBefore)
  // The list re-read after the reload names that same folder, through `location[directory]`, and the
  // reload is recorded before it.
  const reloadIndex = calls().indexOf("reload:/work/demo")
  expect(reloadIndex).toBeGreaterThanOrEqual(0)
  const agentAfterReload = calls().findIndex((call, index) => index > reloadIndex && call === "agent:/work/demo")
  expect(agentAfterReload).toBeGreaterThan(reloadIndex)
})

test("a tool goes unset, off, on and back", async ({ page }) => {
  const { saved } = await open(page, { files: [{ ...reviewer, fields: { description: "d", mode: "subagent" } }] })
  await page.locator(".fc-agent-row").click()

  const bash = page.locator(".fc-agent-tool", { hasText: "bash" })
  await expect(bash).toHaveAttribute("data-state", "unset")
  await bash.click()
  await expect(bash).toHaveAttribute("data-state", "off")
  await bash.click()
  await expect(bash).toHaveAttribute("data-state", "on")

  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()
  await expect.poll(() => saved().length).toBe(1)
  expect((saved()[0]!.fields as { tools: Record<string, boolean> }).tools).toEqual({ bash: true })
})

test("a new one asks for a name, and refuses to save without it", async ({ page }) => {
  const { saved } = await open(page)
  await page.getByRole("button", { name: /New agent|Nuevo agente/ }).click()
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect(page.locator(".fc-run-error")).toContainText(/needs a name|necesita un nombre/)
  // Nothing was sent: a file with no name has nowhere to be written.
  expect(saved()).toHaveLength(0)
})

test("says which agents have no file behind them", async ({ page }) => {
  await open(page)

  // `build` is the engine's own. A form that appeared to edit it would do nothing.
  const block = page.locator(".fc-usage-block").filter({ hasText: /Not editable here|Aquí no se pueden editar/ })
  await expect(block).toContainText("build")
  await expect(block).not.toContainText("reviewer")
  // And not the agents of whatever folder the engine itself was opened in.
  await expect(block).not.toContainText("somewhere-else")
})

test("a file whose frontmatter did not parse says so before it is overwritten", async ({ page }) => {
  await open(page, { files: [{ ...reviewer, fields: {}, problem: "Its frontmatter could not be read: bad token" }] })

  await expect(page.locator(".fc-agent-problem")).toContainText("bad token")
  await page.locator(".fc-agent-row").click()
  await expect(page.locator(".fc-routines-notice")).toContainText(/overwrite|sobrescribir/)
})

test("deleting asks first, and names what it would delete", async ({ page }) => {
  const { deleted } = await open(page)
  await page.locator(".fc-agent-row").click()
  await page.getByRole("button", { name: /^Delete$|^Borrar$/ }).click()

  await expect(page.locator(".fc-confirm-inline")).toContainText("reviewer")
  expect(deleted()).toHaveLength(0)

  await page.locator(".fc-confirm-inline").getByRole("button", { name: /^Delete$|^Borrar$/ }).click()
  await expect.poll(() => deleted()).toEqual(["/work/demo/.opencode/agent/reviewer.md"])
})
