import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const sessions = [
  {
    id: "ses_here",
    projectID: "p",
    title: "Open session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: "/work/demo" },
  },
  {
    id: "ses_away",
    projectID: "p",
    title: "Other session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now - 1, updated: now - 1 },
    location: { directory: "/work/demo" },
  },
]

const editRequest = {
  id: "per_edit",
  sessionID: "ses_here",
  action: "edit",
  resources: ["/work/demo/a.ts"],
  save: ["*"],
  // 2.x names the tool call behind a request `id`.
  source: { messageID: "msg_a", id: "call_1" },
}

const awayRequest = { ...editRequest, id: "per_away", sessionID: "ses_away" }

// Newest first, as 2.x pages them.
const messages = {
  data: [
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      content: [
        {
          type: "tool",
          id: "call_1",
          name: "edit",
          state: {
            status: "streaming",
            input: { path: "/work/demo/a.ts", oldString: "const a = 1", newString: "const a = 2" },
          },
          time: { created: now + 1 },
        },
      ],
      time: { created: now + 1 },
    },
    { id: "msg_u", type: "user", text: "Fix the constant", time: { created: now } },
  ],
  cursor: {},
}

type Recorded = { replies: Array<Record<string, unknown>>; revoked: string[] }

async function openBlockedSession(page: Page, options: { away?: boolean; saved?: unknown[] } = {}) {
  const recorded: Recorded = { replies: [], revoked: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_here"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_here/message") return route.fulfill({ json: messages })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/ses_here/permission")
      return route.fulfill({ json: { data: options.away ? [] : [editRequest] } })
    if (url.pathname === "/api/session/ses_away/permission")
      return route.fulfill({ json: { data: options.away ? [awayRequest] : [] } })
    if (url.pathname === "/api/permission/request")
      return route.fulfill({ json: { data: options.away ? [awayRequest] : [editRequest] } })
    if (url.pathname === "/api/permission/saved") return route.fulfill({ json: { data: options.saved ?? [] } })
    if (/^\/api\/permission\/saved\/(.+)$/.test(url.pathname) && request.method() === "DELETE") {
      recorded.revoked.push(url.pathname.split("/").pop()!)
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname) && request.method() === "POST") {
      recorded.replies.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/session\/[^/]+\/(form|inbox)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return recorded
}

test("an edit shows the change it wants to make, not just the path", async ({ page }) => {
  await openBlockedSession(page)
  const dock = page.locator(".fc-dock-permission")
  await expect(dock).toBeVisible()

  // Approving a bare path is approving a change nobody has seen.
  await expect(dock.locator(".fc-diff-view")).toContainText("-const a = 1")
  await expect(dock.locator(".fc-diff-view")).toContainText("+const a = 2")
  await expect(dock).toContainText("/work/demo/a.ts")
})

test("allow always says how much it is about to allow", async ({ page }) => {
  await openBlockedSession(page)
  // The engine saves `*` for an edit, so one click grants every later edit, not this file.
  await expect(page.locator(".fc-permission-scope")).toContainText(/every edit|cualquier edit/i)
})

test("rejecting can tell the agent why", async ({ page }) => {
  const recorded = await openBlockedSession(page)
  await page.getByRole("button", { name: /^Reject|^Rechazar/ }).click()
  await page.getByPlaceholder(/Why\?|¿Por qué\?/i).fill("Use the other file")
  await page.getByRole("button", { name: /Reject with reason|Rechazar con motivo/i }).click()

  await expect.poll(() => recorded.replies.length).toBe(1)
  expect(recorded.replies[0]).toMatchObject({ decision: "reject", message: "Use the other file" })
})

test("a session blocked somewhere else is visible from here", async ({ page }) => {
  await openBlockedSession(page, { away: true })
  // Nothing in the open session is waiting, but another one is stuck and silent.
  await expect(page.locator(".fc-dock-permission")).toHaveCount(0)
  const badge = page.locator(".fc-status-blocked")
  await expect(badge).toContainText(/1 waiting|1 en espera/i)

  await badge.click()
  await expect(page.locator(".fc-dock-permission")).toBeVisible()
})

test("a permission granted once and remembered forever can be taken back", async ({ page }) => {
  const recorded = await openBlockedSession(page, {
    saved: [{ id: "sav_1", projectID: "p", action: "bash", resource: "rm -rf *" }],
  })
  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  await page.getByRole("tab", { name: /Permissions|Permisos/ }).click()

  const row = page.locator(".fc-saved-permissions li").filter({ hasText: "rm -rf *" })
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: /Revoke|Revocar/ }).click()
  await expect.poll(() => recorded.revoked).toEqual(["sav_1"])
})

// Under the desktop app the engine's own folder is `/`, where a folder's config cannot be written:
// the policy is the user's, so it is read from and saved to the global file.
test("the permission policy is saved to the global config, and only says so once written", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = []
  const refused = { next: true }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    if (url.pathname !== "/harness/engine-config") return route.fulfill({ json: { data: [] } })
    if (route.request().method() !== "PATCH")
      return route.fulfill({
        json: {
          data: {
            path: "/home/me/.config/opencode/opencode.json",
            config: url.searchParams.get("scope") === "global" ? { permission: { bash: "ask" } } : {},
          },
        },
      })
    if (refused.next) {
      refused.next = false
      return route.fulfill({ status: 500, json: { error: "The config file could not be written" } })
    }
    patches.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill({ json: { data: { path: "/home/me/.config/opencode/opencode.json", changed: true } } })
  })
  await openBlockedSession(page)
  // The engine is asked to re-read its config after every save.
  await page.route("http://127.0.0.1:9/api/location/reload", (route) => route.fulfill({ status: 204 }))
  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  await page.getByRole("tab", { name: /Permissions|Permisos/ }).click()

  const editor = page.locator(".fc-permissions-editor")
  await expect(editor.locator("label").filter({ hasText: /^bash/ }).locator("select")).toHaveValue("ask")
  await editor.locator("label").filter({ hasText: /^edit/ }).locator("select").selectOption("deny")
  const save = editor.getByRole("button", { name: /^(Save|Guardar)$/ })
  await save.click()
  // A write that failed does not read as saved.
  await expect(page.getByText("The config file could not be written")).toBeVisible()
  await expect(save).toBeVisible()

  await save.click()
  await expect.poll(() => patches).toEqual([{ scope: "global", patch: { permission: { bash: "ask", edit: "deny" } } }])
  await expect(editor.getByRole("button", { name: /^(Saved|Guardado)$/ })).toBeVisible()
})

// 2.x asks the `question` tool's questions as a form, one field per question.
const questionForm = {
  id: "frm_q",
  sessionID: "ses_here",
  title: "Question",
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Commit/PR",
      description: "The work is already on main. What should I do?",
      options: [
        { label: "Leave it", value: "Leave it", description: "Nothing to open a PR for." },
        { label: "Redo through a branch", value: "Redo through a branch", description: "Rewrites published history." },
      ],
      custom: true,
    },
  ],
}

test("a question the agent asks reaches the reader, and the answer goes back as the form's", async ({ page }) => {
  const answered: Array<{ path: string; body: unknown }> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_here"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_here/message") return route.fulfill({ json: messages })
    if (url.pathname === "/api/session/ses_here/form") return route.fulfill({ json: { data: [questionForm] } })
    if (url.pathname === "/api/session/ses_here/form/frm_q")
      return route.fulfill({ json: { data: { ...questionForm, state: { status: "pending" } } } })
    if (url.pathname === "/api/session/ses_here/form/frm_q/reply") {
      answered.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/(session\/[^/]+\/)?(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const dock = page.locator(".fc-dock-question")
  await expect(dock).toBeVisible()
  await expect(dock).toContainText("The work is already on main")
  await dock.getByRole("button", { name: /Leave it/ }).click()
  await dock.getByRole("button", { name: /Respond|Responder/ }).click()

  await expect
    .poll(() => answered)
    .toEqual([{ path: "/api/session/ses_here/form/frm_q/reply", body: { answer: { q0: "Leave it" } } }])
})
