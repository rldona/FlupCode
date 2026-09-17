import { expect, test, type Page } from "@playwright/test"

const report = {
  totals: { runs: 20, tasks: 66, tokens: 143_920, cost: 1.222, ms: 7_841_004 },
  retries: { tasks: 6, tokens: 30_720, cost: 0.222 },
  byModel: [
    { key: "openai/gpt-5.6", tasks: 20, tokens: 72_400, cost: 0.634 },
    { key: "anthropic/claude-opus-5", tasks: 20, tokens: 71_520, cost: 0.588 },
  ],
  byAgent: [
    { key: "build", tasks: 26, tokens: 96_300, cost: 0.762 },
    { key: "plan", tasks: 20, tokens: 47_620, cost: 0.46 },
  ],
  byProject: [
    { key: "/work/flupcode", tasks: 33, tokens: 71_960, cost: 0.611, runs: 10 },
    { key: "/work/landing", tasks: 33, tokens: 71_960, cost: 0.611, runs: 10 },
  ],
  byDay: [
    { day: "2026-09-16", tokens: 7_000, cost: 0.05 },
    { day: "2026-09-17", tokens: 28_000, cost: 0.2 },
  ],
  slowest: [{ taskID: "t1", runID: "r1", name: "verify", ms: 241_000 }],
}

type Seen = { days: (string | null)[]; directories: (string | null)[] }

async function open(page: Page, over: Record<string, unknown> = {}) {
  const seen: Seen = { days: [], directories: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/usage") {
      seen.days.push(url.searchParams.get("days"))
      seen.directories.push(url.searchParams.get("directory"))
      return route.fulfill({ json: { data: { ...report, ...over } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/usage")
  // Wait for the screen to have answered before handing back what the server was asked, or every
  // assertion about `seen` races the first request.
  await expect(page.getByRole("heading", { name: /^(Cost|Coste)$/ })).toBeVisible()
  await expect.poll(() => seen.days.length).toBeGreaterThan(0)
  return seen
}

test("shows what it cost, which nothing else in the app has ever shown", async ({ page }) => {
  await open(page)

  const tiles = page.locator(".fc-usage-tile")
  await expect(tiles.first()).toContainText("$1.22")
  await expect(page.locator(".fc-usage")).toContainText("143.9k")
  await expect(page.locator(".fc-usage")).toContainText("20")
  // A duration a person reads, not a count of milliseconds.
  await expect(page.locator(".fc-usage")).toContainText("2h 10m")
})

test("calls out what was paid for twice", async ({ page }) => {
  await open(page)

  // A retry is a new task by design, so this money was spent doing something a second time. It was
  // inside the total and invisible; that is the whole reason this screen exists.
  const retries = page.locator(".fc-usage-tile-warn")
  await expect(retries).toContainText("$0.22")
  await expect(retries).toContainText("18%")
})

test("nothing retried is not painted as a problem", async ({ page }) => {
  await open(page, { retries: { tasks: 0, tokens: 0, cost: 0 } })

  await expect(page.locator(".fc-usage-tile-warn")).toHaveClass(/fc-usage-tile-quiet/)
  await expect(page.locator(".fc-usage-tile-warn")).toContainText("$0")
})

test("breaks the bill down by model, by agent and by project", async ({ page }) => {
  await open(page)

  const blocks = page.locator(".fc-usage-block")
  await expect(blocks.filter({ hasText: "By model" })).toContainText("openai/gpt-5.6")
  await expect(blocks.filter({ hasText: "By agent" })).toContainText("build")
  // A project is named by its folder, not by its whole path.
  await expect(blocks.filter({ hasText: "By project" })).toContainText("flupcode")
  await expect(blocks.filter({ hasText: "By project" })).not.toContainText("/work/flupcode")
})

test("the day chart is drawn against its own biggest day", async ({ page }) => {
  await open(page)

  // With a floor of 1 and costs in pennies, every bar came out a few per cent tall.
  const heights = await page
    .locator(".fc-usage-day-bar")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.height))
  expect(heights).toEqual(["25%", "100%"])
})

test("the window is a choice, and it reaches the server", async ({ page }) => {
  const seen = await open(page)
  expect(seen.days).toEqual(["30"])

  await page.getByRole("button", { name: /^(7 days|7 días)$/ }).click()

  await expect.poll(() => seen.days).toEqual(["30", "7"])
})

test("says plainly that it is about runs and not about chat", async ({ page }) => {
  await open(page)
  // The harness never sees an ordinary turn. Claiming this is everything spent would be a lie.
  await expect(page.locator(".fc-routines-header")).toContainText(/not ordinary chat turns|no los turnos de chat/)
})

test("nothing run in the window says so, rather than showing a page of zeroes", async ({ page }) => {
  await open(page, {
    totals: { runs: 0, tasks: 0, tokens: 0, cost: 0, ms: 0 },
    byModel: [],
    byAgent: [],
    byProject: [],
    byDay: [],
    slowest: [],
  })

  await expect(page.getByText(/Nothing has run in this window|No se ha ejecutado nada/)).toBeVisible()
  await expect(page.locator(".fc-usage-tiles")).toHaveCount(0)
})
