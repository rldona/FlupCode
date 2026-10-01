import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_cost",
  projectID: "p",
  title: "Fix the login flow",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const tokens = { input: 2_000, output: 800, reasoning: 200, cacheRead: 6_000, cacheWrite: 2_000, total: 11_000 }

const report = {
  totals: {
    sessions: 1,
    turns: 4,
    tokens,
    cost: 0.4321,
    cached: 0.6,
    turnMs: { p50: 4_200, p95: 12_500 },
    firstTokenMs: { p50: 650, p95: 1_900 },
  },
  sessions: [
    {
      sessionID: "ses_cost",
      projectID: "/work/demo",
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
      turns: 4,
      requests: 9,
      tokens,
      cost: 0.4321,
      cached: 0.6,
      turnMs: { p50: 4_200, p95: 12_500 },
      firstTokenMs: { p50: 650, p95: 1_900 },
      toolCalls: 7,
      toolErrors: 1,
      toolOutputBytes: 60_000,
      topTools: [{ tool: "read", calls: 5, errors: 0, bytes: 51_200 }],
      compactions: 0,
      startedAt: now - 60_000,
      endedAt: now,
    },
  ],
  topTools: [
    { tool: "read", calls: 5, errors: 0, bytes: 51_200 },
    { tool: "bash", calls: 2, errors: 1, bytes: 8_800 },
  ],
}

const empty = {
  totals: {
    sessions: 0,
    turns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    cached: 0,
    turnMs: {},
    firstTokenMs: {},
  },
  sessions: [],
  topTools: [],
}

async function open(page: Page, input: { capabilities?: string[]; answer?: unknown; status?: number }) {
  const asked: URL[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { healthy: true, capabilities: input.capabilities ?? [] } })
    if (url.pathname === "/harness/adaptive/metrics/sessions") {
      asked.push(url)
      if (input.status) return route.fulfill({ status: input.status, json: { error: "The harness is restarting" } })
      return route.fulfill({ json: { data: input.answer ?? report } })
    }
    if (url.pathname === "/harness/usage")
      return route.fulfill({
        json: {
          data: {
            totals: { runs: 0, tasks: 0, tokens: 0, cost: 0, ms: 0 },
            retries: { tasks: 0, tokens: 0, cost: 0 },
            byModel: [],
            byAgent: [],
            byProject: [],
            byDay: [],
            slowest: [],
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
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/usage")
  await expect(page.getByRole("heading", { name: /^(Cost|Coste)$/ })).toBeVisible()
  return asked
}

test("shows what each session cost, named by its title", async ({ page }) => {
  const asked = await open(page, { capabilities: ["adaptive-metrics"] })
  const section = page.locator(".fc-session-costs")

  await expect(section.locator(".fc-usage-tile").first()).toContainText("$0.43")
  await expect(section).toContainText("11.0k")
  await expect(section).toContainText("60%")
  await expect(section).toContainText("4.2 s / 12.5 s")
  await expect(section).toContainText("650 ms / 1.9 s")
  await expect(section.locator(".fc-session-cost-row", { hasText: "Fix the login flow" })).toContainText("claude-sonnet-5")
  await expect(section.locator(".fc-session-cost-tools")).toContainText("read")
  await expect(section.locator(".fc-session-cost-tools")).toContainText("50 kB")
  // The window the runs above use reaches this read too.
  expect(asked[0]?.searchParams.get("since")).not.toBeNull()
})

test("nothing measured says so, instead of a page of zeroes", async ({ page }) => {
  await open(page, { capabilities: ["adaptive-metrics"], answer: empty })

  await expect(page.getByText(/No session has been measured in this window|No se ha medido ninguna sesión/)).toBeVisible()
  await expect(page.locator(".fc-session-costs .fc-usage-tiles")).toHaveCount(0)
})

test("a server without the metrics is never asked, and the screen says why", async ({ page }) => {
  const asked = await open(page, { capabilities: [] })

  await expect(page.getByText(/does not record session metrics|no registra métricas de sesión/)).toBeVisible()
  expect(asked).toHaveLength(0)
})

test("a failed read is said where the table would be, with a way to try again", async ({ page }) => {
  await open(page, { capabilities: ["adaptive-metrics"], status: 503 })

  await expect(page.locator(".fc-session-costs .fc-panel-error")).toContainText("The harness is restarting")
  await expect(page.locator(".fc-session-costs").getByRole("button", { name: /Try again|Reintentar/ })).toBeVisible()
})
