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
  source: { type: "tool", messageID: "msg_a", callID: "call_1" },
}

const awayRequest = { ...editRequest, id: "per_away", sessionID: "ses_away" }

const messages = {
  data: [
    { id: "msg_u", type: "user", text: "Fix the constant", time: { created: now } },
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
            status: "pending",
            input: { path: "/work/demo/a.ts", oldString: "const a = 1", newString: "const a = 2" },
          },
          time: { created: now + 1 },
        },
      ],
      time: { created: now + 1 },
    },
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
      return route.fulfill({ json: {} })
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname) && request.method() === "POST") {
      recorded.replies.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: {} })
    }
    if (/^\/api\/session\/[^/]+\/question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
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
  expect(recorded.replies[0]).toMatchObject({ reply: "reject", message: "Use the other file" })
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
  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  await page.getByRole("tab", { name: /Permissions|Permisos/ }).click()

  const row = page.locator(".fc-saved-permissions li").filter({ hasText: "rm -rf *" })
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: /Revoke|Revocar/ }).click()
  await expect.poll(() => recorded.revoked).toEqual(["sav_1"])
})

// Every turn runs on the legacy runtime, which keeps its blocked work in its own registry. Reading
// only the v2 one left an agent waiting on a question that no dock could show, with no way to answer
// it from the app at all.
const legacyQuestion = {
  id: "que_legacy",
  sessionID: "ses_here",
  questions: [
    {
      header: "Commit/PR",
      question: "The work is already on main. What should I do?",
      options: [
        { label: "Leave it", description: "Nothing to open a PR for." },
        { label: "Redo through a branch", description: "Rewrites published history." },
      ],
    },
  ],
}

const legacyPermission = {
  id: "per_legacy",
  sessionID: "ses_here",
  permission: "bash",
  patterns: ["rm -rf build"],
  always: ["rm -rf build"],
  metadata: {},
}

async function openWithLegacyBlock(page: Page, kind: "question" | "permission") {
  const answered: Array<{ path: string; body: unknown }> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_here"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_here/message") return route.fulfill({ json: messages })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    // The v2 registries know nothing about it…
    if (/^\/api\/(session\/[^/]+\/)?(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    // …while the legacy one, the only one that can unblock the turn, has it.
    if (url.pathname === "/question" && request.method() === "GET")
      return route.fulfill({ json: kind === "question" ? [legacyQuestion] : [] })
    if (url.pathname === "/permission" && request.method() === "GET")
      return route.fulfill({ json: kind === "permission" ? [legacyPermission] : [] })
    if (/^\/(question|permission)\/[^/]+\/(reply|reject)$/.test(url.pathname)) {
      answered.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return answered
}

test("a question only the legacy runtime knows about still reaches the reader", async ({ page }) => {
  const answered = await openWithLegacyBlock(page, "question")

  const dock = page.locator(".fc-dock-question")
  await expect(dock).toBeVisible()
  await expect(dock).toContainText("The work is already on main")
  await dock.getByRole("button", { name: /Leave it/ }).click()
  await dock.getByRole("button", { name: /Respond|Responder/ }).click()

  // And the answer goes back to the runtime that asked, which is the only one that can unblock it.
  await expect.poll(() => answered.map((call) => call.path)).toEqual(["/question/que_legacy/reply"])
})

test("a permission only the legacy runtime knows about still reaches the reader", async ({ page }) => {
  const answered = await openWithLegacyBlock(page, "permission")

  const dock = page.locator(".fc-dock-permission")
  await expect(dock).toBeVisible()
  await expect(dock).toContainText("rm -rf build")
  await dock.getByRole("button", { name: /Allow once|Permitir una vez/ }).click()

  await expect.poll(() => answered.map((call) => call.path)).toEqual(["/permission/per_legacy/reply"])
})
