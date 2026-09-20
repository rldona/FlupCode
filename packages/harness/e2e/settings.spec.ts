import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_set",
  projectID: "p",
  title: "Settings",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const commandFiles = [
  {
    name: "review",
    path: "/work/demo/.opencode/command/review.md",
    scope: "project",
    root: "/work/demo/.opencode",
    fields: { description: "Review a diff" },
    template: "Review $ARGUMENTS.",
    bytes: 40,
  },
]

type Calls = {
  posts: Array<{ path: string; body: unknown }>
  patches: Array<{ path: string; body: unknown }>
  deletes: string[]
}

async function openApp(page: Page) {
  const calls: Calls = { posts: [], patches: [], deletes: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_set"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["session-prefs", "stash"] } } })
    if (url.pathname === "/harness/commands" && request.method() === "GET")
      return route.fulfill({ json: { data: commandFiles } })
    if (url.pathname === "/harness/commands" && request.method() === "POST") {
      calls.posts.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ json: { data: { path: "/work/demo/.opencode/command/review.md" } } })
    }
    if (url.pathname === "/harness/commands" && request.method() === "DELETE") {
      calls.deletes.push(url.searchParams.get("path") ?? "")
      return route.fulfill({ json: { data: { removed: true } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_set/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/mcp" && request.method() === "GET")
      return route.fulfill({ json: { docs: { status: "connected" } } })
    if (url.pathname === "/config" && request.method() === "GET")
      return route.fulfill({
        json: {
          mcp: { docs: { type: "remote", url: "https://docs.example" } },
          permission: { edit: "allow", bash: { "rm -rf *": "deny" } },
        },
      })
    if (url.pathname === "/config" && request.method() === "PATCH") {
      calls.patches.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/mcp" && request.method() === "POST") return route.fulfill({ json: { status: {} } })
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(url.pathname)) return route.fulfill({ json: {} })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return calls
}

const openSettings = async (page: Page) => {
  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  await expect(page.getByRole("dialog", { name: "Customize" })).toBeVisible()
  return page.getByRole("dialog", { name: "Customize" })
}

test("settings is a rail of sections, and the editors live inside it", async ({ page }) => {
  await openApp(page)
  const dialog = await openSettings(page)

  await expect(dialog.getByRole("tablist")).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true")

  // Commands are read from the harness server, not from a modal of their own.
  await dialog.getByRole("tab", { name: "Commands" }).click()
  await expect(dialog.getByText("/review")).toBeVisible()

  await dialog.getByRole("tab", { name: "MCP servers" }).click()
  await expect(dialog.locator(".fc-mcp-row")).toHaveCount(1)

  await dialog.getByRole("tab", { name: "Advanced" }).click()
  await expect(dialog.getByRole("button", { name: "Agents" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Skills" })).toBeVisible()
})

test("a command is written to the harness server from the form", async ({ page }) => {
  const calls = await openApp(page)
  const dialog = await openSettings(page)

  await dialog.getByRole("tab", { name: "Commands" }).click()
  await dialog.getByRole("button", { name: "New command" }).click()
  await dialog.getByPlaceholder("git/release").fill("git/release")
  await dialog.getByPlaceholder(/What the command says/).fill("Cut a release.")
  await dialog.getByRole("button", { name: "Save" }).click()

  await expect
    .poll(() => calls.posts.find((call) => call.path === "/harness/commands")?.body)
    .toMatchObject({ name: "git/release", template: "Cut a release." })
})

test("an MCP server can be given an environment and headers, not just a command", async ({ page }) => {
  const calls = await openApp(page)
  const dialog = await openSettings(page)

  await dialog.getByRole("tab", { name: "MCP servers" }).click()
  await dialog.getByPlaceholder("Name").fill("local1")
  await dialog.getByPlaceholder("command and arguments").fill("npx -y server")
  await dialog.getByPlaceholder("API_KEY=…").fill("API_KEY=abc\nDEBUG=true")
  await dialog.locator(".fc-mcp-form .fc-button-primary").click()

  await expect
    .poll(() => calls.patches.find((call) => call.path === "/config")?.body)
    .toMatchObject({
      mcp: {
        local1: { type: "local", command: ["npx", "-y", "server"], environment: { API_KEY: "abc", DEBUG: "true" } },
      },
    })
})

test("a pattern rule is edited in place, and survives the save", async ({ page }) => {
  const calls = await openApp(page)
  const dialog = await openSettings(page)

  await dialog.getByRole("tab", { name: "Permissions" }).click()
  // The rule the engine had is editable: tool, pattern and action.
  await expect(dialog.getByLabel("Pattern").first()).toHaveValue("rm -rf *")
  await dialog.getByLabel("Action").first().selectOption("ask")

  await dialog.locator(".fc-settings-row", { hasText: "edit" }).getByRole("combobox").selectOption("deny")
  await dialog.getByRole("button", { name: "Save" }).click()

  await expect
    .poll(() => calls.patches.find((call) => call.path === "/config")?.body)
    .toMatchObject({ permission: { edit: "deny", bash: { "rm -rf *": "ask" } } })
})

// H-34: a server that failed says why, what it exposes is shown, and so is who may use it.
test("an MCP server shows its failure, its resources and the agents that allow it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_set"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["session-prefs"] } } })
    if (url.pathname === "/harness/agents")
      return route.fulfill({
        json: {
          data: [
            {
              name: "build",
              path: "/work/demo/.opencode/agent/build.md",
              scope: "project",
              root: "/work/demo/.opencode",
              fields: { tools: { docs_search: true } },
              prompt: "",
              bytes: 0,
            },
          ],
        },
      })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/mcp")
      return route.fulfill({
        json: {
          docs: { status: "connected" },
          broken: { status: "failed", error: "spawn ENOENT" },
        },
      })
    if (url.pathname === "/experimental/resource")
      return route.fulfill({
        json: {
          "docs://readme": { name: "readme", uri: "docs://readme", mimeType: "text/markdown", client: "docs" },
        },
      })
    if (url.pathname === "/config")
      return route.fulfill({
        json: { mcp: { docs: { type: "remote", url: "https://docs.example" }, broken: { type: "local", command: ["x"] } } },
      })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "MCP servers" }).click()

  const rows = dialog.locator(".fc-mcp-row")
  await expect(rows).toHaveCount(2)
  // The reason it is not working, not just that it is not.
  await expect(dialog.locator(".fc-mcp-error")).toContainText("spawn ENOENT")
  // What it exposes.
  await expect(dialog.locator(".fc-mcp-resource")).toContainText("readme")
  await expect(dialog.locator(".fc-mcp-resource-uri")).toContainText("docs://readme")
  // And who may reach it, from the agent files the engine reads.
  await expect(dialog.locator(".fc-mcp-access")).toContainText("build")
  // A server no agent allows says so instead of looking open.
  await expect(dialog.locator(".fc-mcp-access-none")).toHaveCount(1)
})

test("a conversation toggle survives a reload", async ({ page }) => {
  await openApp(page)
  let dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Conversation" }).click()

  const tools = dialog.locator(".fc-settings-row", { hasText: "Show tool steps" }).getByRole("button")
  await expect(tools).toHaveText(/^Yes$|^Sí$/)
  await tools.click()
  await expect(tools).toHaveText(/^No$/)

  await page.reload()
  dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Conversation" }).click()
  await expect(dialog.locator(".fc-settings-row", { hasText: "Show tool steps" }).getByRole("button")).toHaveText(
    /^No$/,
  )
})
