import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_actions",
  projectID: "p",
  title: "Actions",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const publish = {
  id: "publish",
  scope: "global",
  tool: "do_publish",
  description: "Publish the piece.",
  kind: "browser",
  origin: "https://example.com",
  inputs: { text: "string" },
  steps: [{ goto: "{{origin}}/compose" }, { fill: { selector: "#body", text: "{{text}}" } }],
  guards: [],
  sensitive: true,
  availability: "host",
  evidence: { screenshots: "each" },
}

const local = { ...publish, id: "local", scope: "project", tool: "do_local", description: "Only in this project." }

type Calls = { saves: Array<Record<string, unknown>>; previews: Array<Record<string, unknown>>; validates: number }

async function open(page: Page) {
  const calls: Calls = { saves: [], previews: [], validates: 0 }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_actions"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["action-profiles", "web-actions"] } } })
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    if (url.pathname === "/harness/actions" && request.method() === "GET")
      return route.fulfill({ json: { data: { profiles: [publish, local], rejected: [] } } })
    if (url.pathname === "/harness/actions/validate" && request.method() === "POST") {
      calls.validates += 1
      return route.fulfill({ json: { data: { ok: true, profile: publish } } })
    }
    if (url.pathname.startsWith("/harness/action-profiles/") && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>
      calls.saves.push(body)
      return route.fulfill({
        status: 201,
        json: { data: { path: "/config/opencode.jsonc", scope: body.scope, id: "publish" } },
      })
    }
    if (url.pathname === "/harness/actions/run" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>
      calls.previews.push(body)
      return route.fulfill({
        json: {
          data: {
            action: "publish",
            tool: "do_publish",
            status: "preview",
            origin: "https://example.com",
            url: "https://example.com/compose",
            title: "Compose",
            startedAt: now,
            finishedAt: now + 1,
            steps: [
              { index: 0, kind: "goto", status: "ok", attempts: 1, durationMs: 1 },
              { index: 1, kind: "fill", status: "skipped", attempts: 0, durationMs: 0 },
            ],
          },
        },
      })
    }
    if (url.pathname === "/harness/browser/frame") return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  // The nav item, not a session that happens to be called "Actions".
  await page.locator(".fc-nav").getByRole("button", { name: /Actions|Acciones/ }).click()
  const screen = page.locator(".fc-actions-screen")
  await expect(screen).toBeVisible()
  return { screen, calls }
}

test("lists global and project actions, and marks project ones as not agent-visible", async ({ page }) => {
  const { screen } = await open(page)

  await expect(screen.locator(".fc-actions-card", { hasText: "publish" })).toHaveCount(1)
  await expect(screen.locator(".fc-actions-card", { hasText: "local" })).toHaveCount(1)

  await screen.locator(".fc-actions-card", { hasText: "local" }).click()
  await expect(screen).toContainText(/not available|plugin loads global|no está disponible|solo carga perfiles globales/)
  await expect(screen.getByRole("button", { name: /Move to global|Mover a global/ })).toBeVisible()
})

test("validates a draft and saves it to the config file the server derives", async ({ page }) => {
  const { screen, calls } = await open(page)
  await screen.locator(".fc-actions-card", { hasText: "publish" }).click()

  await screen.getByRole("button", { name: /^Validate$|^Validar$/ }).click()
  await expect.poll(() => calls.validates).toBe(1)
  await expect(screen).toContainText(/valid|válido/)

  await screen.getByRole("button", { name: /^Save$|^Guardar$/ }).click()
  await expect.poll(() => calls.saves.length).toBe(1)
  expect(calls.saves[0]).toMatchObject({ scope: "global", profile: { tool: "do_publish" } })
})

test("previews a recipe and shows the skipped side effect", async ({ page }) => {
  const { screen, calls } = await open(page)
  await screen.locator(".fc-actions-card", { hasText: "publish" }).click()

  await screen.getByRole("button", { name: /^Preview$|^Previsualizar$/ }).click()
  await expect.poll(() => calls.previews.length).toBe(1)
  expect(calls.previews[0]).toMatchObject({ preview: true, profile: { tool: "do_publish" } })

  const steps = screen.locator(".fc-actions-preview li")
  await expect(steps.filter({ hasText: "fill" })).toContainText("skipped")
  await expect(steps.filter({ hasText: "goto" })).toContainText("ok")
})
