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

const location = {
  directory: "/work/demo",
  project: { id: "p", directory: "/work/demo", canonical: "/work/demo" },
}

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
    // OpenCode 2 writes no config files, so the harness server reads and patches them (V2-24).
    if (url.pathname === "/harness/engine-config" && request.method() === "PATCH") {
      calls.patches.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ json: { data: { path: "/home/opencode.json", changed: true } } })
    }
    if (url.pathname === "/harness/engine-config")
      return route.fulfill({
        json: {
          data: {
            path: "/home/opencode.json",
            config:
              url.searchParams.get("scope") === "global"
                ? { mcp: { docs: { type: "remote", url: "https://docs.example" } } }
                : { permission: { edit: "allow", bash: { "rm -rf *": "deny" } } },
          },
        },
      })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_set/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/location") return route.fulfill({ json: location })
    if (url.pathname === "/api/mcp")
      return route.fulfill({
        json: { location: { directory: "/work/demo" }, data: [{ name: "docs", status: { status: "connected" } }] },
      })
    if (url.pathname === "/api/location/reload") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return calls
}

const openSettings = async (page: Page) => {
  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
  return page.getByRole("dialog", { name: "Settings" })
}

test("settings is a rail of sections, and the editors live inside it", async ({ page }) => {
  await openApp(page)
  const dialog = await openSettings(page)

  await expect(dialog.getByRole("tablist")).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true")

  // Wide: a labelled rail, and one close button floating on the content pane instead of a title bar.
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible()
  await expect(dialog.locator(".fc-settings-header-title")).toBeHidden()
  await expect(dialog.locator(".fc-settings-group-label", { hasText: "General" })).toBeVisible()

  // Commands are read from the harness server, not from a modal of their own.
  await dialog.getByRole("tab", { name: "Commands" }).click()
  await expect(dialog.getByText("/review")).toBeVisible()

  await dialog.getByRole("tab", { name: "MCP servers" }).click()
  await expect(dialog.locator(".fc-mcp-row")).toHaveCount(1)

  // Settings holds configuration only (UX-01): Skills is a screen of its own, Agents a section.
  await dialog.getByRole("tab", { name: "Advanced" }).click()
  await expect(dialog.getByRole("button", { name: "Config (advanced)" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Config files" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Skills" })).toHaveCount(0)
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
  await dialog.getByRole("button", { name: "Add server" }).click()
  await dialog.getByPlaceholder("Name").fill("local1")
  await dialog.getByPlaceholder("command and arguments").fill("npx -y server")
  await dialog.getByPlaceholder("API_KEY=…").fill("API_KEY=abc\nDEBUG=true")
  // Off, the tools are offered one by one instead of through `execute`.
  await dialog.getByRole("checkbox", { name: "Code Mode" }).uncheck()
  await dialog.locator(".fc-mcp-form .fc-button-primary").click()

  await expect
    .poll(() => calls.patches.find((call) => call.path === "/harness/engine-config")?.body)
    .toMatchObject({
      scope: "global",
      patch: {
        mcp: {
          servers: {
            local1: {
              type: "local",
              command: ["npx", "-y", "server"],
              environment: { API_KEY: "abc", DEBUG: "true" },
              codemode: false,
            },
          },
        },
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

  await dialog.locator("label.fc-settings-row", { hasText: "edit" }).getByRole("combobox").selectOption("deny")
  await dialog.getByRole("button", { name: "Save" }).click()

  await expect
    .poll(() => calls.patches.find((call) => call.path === "/harness/engine-config")?.body)
    .toMatchObject({
      scope: "project",
      directory: "/work/demo",
      patch: { permission: { edit: "deny", bash: { "rm -rf *": "ask" } } },
    })
})

// H-34: a server that failed says why, what it exposes is shown, and so is who may use it.
test("an MCP server shows its failure, its resources and the agents that allow it", async ({ page }) => {
  const patches: unknown[] = []
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
              fields: { permission: { "*": "deny", docs_search: "allow", execute: "allow" } },
              prompt: "",
              bytes: 0,
            },
            {
              // Written for 1.x: its tools by name and nothing else, so Code Mode leaves it without them.
              name: "publisher",
              path: "/home/.config/opencode/agent/publisher.md",
              scope: "global",
              root: "/home/.config/opencode",
              fields: { permission: { "*": "deny", docs_search: "allow" } },
              prompt: "",
              bytes: 0,
            },
          ],
        },
      })
    if (url.pathname === "/harness/engine-config" && route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON())
      return route.fulfill({ json: { data: { path: "/home/opencode.json", changed: true } } })
    }
    if (url.pathname === "/harness/engine-config")
      return route.fulfill({
        json: {
          data: {
            path: "/home/opencode.json",
            config:
              url.searchParams.get("scope") === "global"
                ? {
                    mcp: {
                      docs: { type: "remote", url: "https://docs.example" },
                      broken: { type: "local", command: ["x"] },
                    },
                  }
                : {},
          },
        },
      })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/location") return route.fulfill({ json: location })
    if (url.pathname === "/api/location/reload") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/mcp")
      return route.fulfill({
        json: {
          location: { directory: "/work/demo" },
          data: [
            { name: "docs", status: { status: "connected" } },
            { name: "broken", status: { status: "failed", error: "spawn ENOENT" } },
          ],
        },
      })
    if (url.pathname === "/api/mcp/resource")
      return route.fulfill({
        json: {
          location: { directory: "/work/demo" },
          data: {
            resources: [{ server: "docs", name: "readme", uri: "docs://readme", mimeType: "text/markdown" }],
            templates: [],
          },
        },
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
  // And who may reach it, from the agents' permissions.
  await expect(dialog.locator(".fc-mcp-access")).toHaveText("Agents that allow it: build")
  // A server no agent allows says so instead of looking open.
  await expect(dialog.locator(".fc-mcp-access-none")).toHaveCount(1)

  // An agent that lists the tools but not `execute` is told apart, with the way out.
  const blocked = rows.filter({ hasText: "docs" }).locator(".fc-mcp-blocked")
  await expect(blocked).toContainText("Code Mode hides this server from publisher")
  await blocked.getByRole("button", { name: "Turn off Code Mode" }).click()
  await expect
    .poll(() => patches[0])
    .toMatchObject({
      scope: "global",
      // Under `mcp.servers`: the engine drops `codemode` from a server written the 1.x way.
      patch: {
        mcp: { docs: null, servers: { docs: { type: "remote", url: "https://docs.example", codemode: false } } },
      },
    })
})

test("a conversation toggle survives a reload", async ({ page }) => {
  await openApp(page)
  let dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Conversation" }).click()

  const tools = dialog.locator(".fc-settings-row", { hasText: "Show tool steps" }).getByRole("switch")
  await expect(tools).toHaveAttribute("aria-checked", "true")
  await tools.click()
  await expect(tools).toHaveAttribute("aria-checked", "false")

  await page.reload()
  dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Conversation" }).click()
  await expect(dialog.locator(".fc-settings-row", { hasText: "Show tool steps" }).getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  )
})

test("on a narrow screen the rail becomes a horizontally scrollable tab strip", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 })
  await openApp(page)
  // On narrow screens the profile menu, where Settings lives, is in the off-canvas sidebar.
  await page.getByTitle("Toggle sidebar").click()
  const dialog = await openSettings(page)

  // The group labels give way to a header title, and the tabs stay on one scrollable line.
  await expect(dialog.locator(".fc-settings-group-label").first()).toBeHidden()
  await expect(dialog.locator(".fc-settings-header-title")).toBeVisible()

  const nav = dialog.getByRole("tablist")
  await expect(nav).toHaveCSS("flex-wrap", "nowrap")
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  // The strip scrolls horizontally. RTL scrolls toward negative values, so match the direction.
  const scrolled = await nav.evaluate((el) => {
    const rtl = getComputedStyle(el).direction === "rtl"
    el.scrollLeft = rtl ? -el.scrollWidth : el.scrollWidth
    return Math.abs(el.scrollLeft) > 0
  })
  expect(scrolled).toBe(true)
})
