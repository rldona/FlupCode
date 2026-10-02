import { expect, test, type Page } from "@playwright/test"

// UX-02: one attention scale. A gate waiting for the reader used to show only on the Runs screen;
// a session waiting on a permission was an amber dot, on a question a hand, and a routine's run at
// its gate an amber dot with "Needs your input". Now each state has one mark, wherever it is listed.

const now = Date.now()

const session = (id: string, title: string) => ({
  id,
  projectID: "p",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
})

const gated = {
  id: "run_gate",
  source: { type: "routine", routineID: "rt_1" },
  workflow: { name: "parser-rename", scope: "project", hash: "h", inputs: {} },
  status: "awaiting",
  paused: "gate",
  startedAt: now - 60_000,
  sessionID: "ses_run",
}

const routine = {
  id: "rt_1",
  name: "Nightly parser rename",
  description: "",
  prompt: "Rename the parser",
  enabled: true,
  schedule: { type: "daily", hour: 3, minute: 0 },
  createdAt: now,
  runs: [gated],
}

async function open(page: Page, engine: { permissions?: unknown[]; forms?: unknown[] } = {}) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.view", JSON.stringify("code"))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          data: [
            session("ses_perm", "Allow the shell"),
            session("ses_ask", "Pick the parser"),
            session("ses_web", "Read the changelog"),
          ],
          cursor: {},
        },
      })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    // Every session's open requests: what marks a session that is not the open one.
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: engine.permissions ?? [] } })
    if (url.pathname === "/api/form") return route.fulfill({ json: { data: engine.forms ?? [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [routine] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [gated] } })
    if (/^\/harness\/runs\/[^/]+\/tasks$/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-sidebar")).toBeVisible()
}

const runsItem = (page: Page) => page.locator("button.fc-nav-item", { hasText: /Runs|Ejecuciones/ })

test("a run waiting at its gate shows on the sidebar from any screen", async ({ page }) => {
  await open(page)

  // From the home screen: on the Runs item, counted, and on the routine that started it.
  await expect(runsItem(page).getByRole("img", { name: "Needs approval (1)" })).toBeVisible()
  const routineRow = page.locator(".fc-sidebar-routine", { hasText: "Nightly parser rename" })
  await expect(routineRow.getByRole("img", { name: "Needs approval" })).toBeVisible()

  // From other screens too: the sidebar is the same wherever the main column is.
  for (const screen of [/Workflows|Flujos/, /Artifacts|Artefactos/]) {
    await page.locator("button.fc-nav-item", { hasText: screen }).click()
    await expect(runsItem(page).getByRole("img", { name: "Needs approval (1)" })).toBeVisible()
  }

  // And the card itself carries the same mark, next to its Approve.
  await runsItem(page).click()
  const card = page.locator(".fc-run-card")
  await expect(card.locator('.fc-attention[data-attention="approval"]')).toBeVisible()
  await expect(card.getByRole("button", { name: /Approve|Aprobar/ })).toBeVisible()

  // The routine's own history says it in the same word.
  await page.locator(".fc-sidebar-routine", { hasText: "Nightly parser rename" }).click()
  const history = page.locator(".fc-routine-runs")
  await expect(history.getByRole("img", { name: "Needs approval" })).toBeVisible()
  await expect(history).toContainText("Needs approval")
  await expect(history).not.toContainText("Needs your input")
})

test("the same state looks the same on a session, a run and a routine", async ({ page }) => {
  await open(page, {
    permissions: [
      {
        id: "per_1",
        sessionID: "ses_perm",
        action: "shell",
        resources: ["echo hi"],
        source: { type: "tool", messageID: "m", callID: "c" },
      },
    ],
    forms: [
      {
        id: "frm_1",
        sessionID: "ses_ask",
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            title: "Parser",
            description: "Which one?",
            type: "string",
            options: [{ value: "CLI", label: "CLI" }],
          },
        ],
      },
      // A browser approval (BU-01) arrives as a form too, but it asks for leave, not for an answer.
      {
        id: "frm_2",
        sessionID: "ses_web",
        title: "Browser approval",
        metadata: { flupcode: "browser-approval", origin: "https://example.com", site: "example.com", tier: "read" },
        fields: [{ key: "q0", title: "Allow?", type: "string", options: [{ value: "once", label: "Allow once" }] }],
      },
    ],
  })
  await page.locator(".fc-project-toggle").first().click()

  const mark = (scope: ReturnType<Page["locator"]>) => scope.locator(".fc-attention").first()
  const look = (scope: ReturnType<Page["locator"]>) =>
    mark(scope).evaluate((node) => {
      const style = getComputedStyle(node)
      return [node.getAttribute("data-attention"), style.backgroundColor, style.borderRadius, style.borderStyle].join(
        " ",
      )
    })

  // A session waiting on a permission and a run waiting at its gate both need an approval, and
  // both are drawn the same way; the routine whose run that is, too.
  const permissionRow = page.locator(".fc-session-row", { hasText: "Allow the shell" })
  await expect(permissionRow.getByRole("img", { name: "Needs approval" })).toBeVisible()
  const routineRow = page.locator(".fc-sidebar-routine", { hasText: "Nightly parser rename" })
  expect(await look(permissionRow)).toBe(await look(routineRow))

  // A question is the next level down, and looks different from an approval.
  const questionRow = page.locator(".fc-session-row", { hasText: "Pick the parser" })
  await expect(questionRow.getByRole("img", { name: "Needs your input" })).toBeVisible()
  expect(await look(questionRow)).not.toBe(await look(permissionRow))

  const browserRow = page.locator(".fc-session-row", { hasText: "Read the changelog" })
  await expect(browserRow.getByRole("img", { name: "Needs approval" })).toBeVisible()
  expect(await look(browserRow)).toBe(await look(permissionRow))

  // Collapsed, the project says how many of its sessions are at its most urgent level.
  await page.locator(".fc-project-toggle").first().click()
  await expect(page.locator(".fc-project-toggle").getByRole("img", { name: "Needs approval (2)" })).toBeVisible()
})
