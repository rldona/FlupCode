import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { expect, test, type Page } from "@playwright/test"

/**
 * The Cost screen and the disclosure ladder (UL-06) against a fixture ledger: the real harness-server
 * routes over the rows `usage-ledger.fixture.ts` writes, so every figure checked here is what the
 * summary, session and run reads answer. The engine is mocked: only the sessions the composer needs.
 */

let harness: ChildProcess | undefined
let harnessUrl = ""

const now = Date.now()
const yesterday = (() => {
  const at = new Date(now)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1, 11).getTime()
})()

const session = (id: string, title: string) => ({
  id,
  projectID: "p",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: yesterday, updated: yesterday },
  location: { directory: "/work/flupcode" },
})
const sessions = [session("ses_task_a", "Write the login"), session("ses_unmeasured", "Nothing measured")]
const transcript = (sessionID: string) => [
  { id: `${sessionID}_u1`, sessionID, type: "user", text: "Write it", time: { created: yesterday, completed: yesterday } },
  {
    id: `${sessionID}_a1`,
    sessionID,
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "sonnet" },
    cost: 0,
    tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 4000, write: 0 } },
    time: { created: yesterday + 1, completed: yesterday + 2 },
    content: [{ type: "text", id: `${sessionID}_p`, text: "Done." }],
  },
]

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

test.beforeAll(async () => {
  const port = await freePort()
  harnessUrl = `http://127.0.0.1:${port}`
  harness = spawn("bun", [fileURLToPath(new URL("./usage-ledger.fixture.ts", import.meta.url))], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 50; attempt++) {
    const answer = await fetch(`${harnessUrl}/harness/health`).catch(() => undefined)
    if (answer?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("the fixture ledger did not start")
})

test.afterAll(() => {
  harness?.kill()
})

/** The app on `path`, with the fixture ledger as its harness and a mocked engine. */
async function open(page: Page, path: string, selected?: string) {
  const asked: URL[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith("/harness/usage")) asked.push(url)
  })
  await page.addInitScript(
    (values) => {
      window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
      window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
      window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify(values.harness))
      window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "anthropic", id: "sonnet" }))
      if (values.selected) window.localStorage.setItem("flupcode.selectedSession", JSON.stringify(values.selected))
    },
    { harness: harnessUrl, selected },
  )
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model")
      return route.fulfill({
        json: {
          data: [
            {
              id: "sonnet",
              providerID: "anthropic",
              name: "Sonnet",
              limit: { context: 200_000, output: 8_000 },
              cost: [],
              status: "active",
              enabled: true,
              variants: [],
            },
          ],
        },
      })
    const messages = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (messages) return route.fulfill({ json: { data: [...transcript(messages[1]!)].reverse(), cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(path)
  return asked
}

const tile = (page: Page, lens: string) => page.locator(`.fc-usage-tile[data-lens="${lens}"]`)

test("the three money lenses read apart, what had no price is counted apart, and nothing is a dash", async ({
  page,
}) => {
  await open(page, "/cost")

  // Thirty days: every pay-per-use row ($0.30 + $0.05 + $0.08 + $0.50 + $0.02 + $1.00), as an estimate.
  await expect(tile(page, "estimated").locator(".fc-usage-tile-value")).toHaveText("~$1.95")
  // The tile is named Notional, so its figure is the money alone, drawn the notional way.
  await expect(tile(page, "notional").locator(".fc-usage-tile-value")).toHaveText("$0.12")
  await expect(tile(page, "notional").locator(".fc-usage-tile-label")).toHaveText("Notional")
  // No provider reported a charge: a dash, never $0.
  await expect(tile(page, "measured").locator(".fc-usage-tile-value")).toHaveText("—")
  await expect(tile(page, "unpriced").locator(".fc-usage-tile-value")).toHaveText("3 model calls")
  for (const lens of ["estimated", "measured", "notional", "unpriced"])
    await expect(tile(page, lens).locator(".fc-usage-tile-value")).not.toHaveText(/^\$0$/)

  // Told apart by how they look, not only by what they say.
  const style = (lens: string) =>
    tile(page, lens)
      .locator(".fc-usage-tile-value")
      .evaluate((node) => {
        const computed = getComputedStyle(node)
        return `${computed.color}|${computed.fontStyle}|${computed.borderTopStyle}`
      })
  const looks = new Set([await style("estimated"), await style("notional"), await style("unpriced")])
  expect(looks.size).toBe(3)
})

test("the period is a choice, and it reaches the ledger", async ({ page }) => {
  const asked = await open(page, "/cost")
  await expect(tile(page, "estimated").locator(".fc-usage-tile-value")).toHaveText("~$1.95")

  await page.getByRole("button", { name: /^(7 days|7 días)$/ }).click()

  // The old chat of 20 days ago is out.
  await expect(tile(page, "estimated").locator(".fc-usage-tile-value")).toHaveText("~$0.95")
  expect(asked.some((url) => url.searchParams.get("groupBy") === "model" && url.searchParams.has("from"))).toBe(true)
})

test("the project selector narrows every figure to that project", async ({ page }) => {
  await open(page, "/cost")
  await expect(tile(page, "estimated").locator(".fc-usage-tile-value")).toHaveText("~$1.95")

  await page.locator(".fc-usage-toolbar select").selectOption("/work/landing")

  // The chat in /work/landing: $0.50 and the $0.02 compaction, with its two unpriced calls.
  await expect(tile(page, "estimated").locator(".fc-usage-tile-value")).toHaveText("~$0.52")
  await expect(tile(page, "notional").locator(".fc-usage-tile-value")).toHaveText("—")
  await expect(tile(page, "unpriced").locator(".fc-usage-tile-value")).toHaveText("2 model calls")
})

test("the group-by switch asks the ledger by that dimension, and every row's figure opens its basis", async ({
  page,
}) => {
  const asked = await open(page, "/cost")
  const grouped = page.locator(".fc-usage-block").filter({ has: page.locator("#fc-usage-grouped") })
  await expect(grouped.locator(".fc-usage-row").first()).toContainText("anthropic/sonnet")

  await grouped.getByRole("combobox").selectOption("agent")
  await expect.poll(() => asked.some((url) => url.searchParams.get("groupBy") === "agent")).toBe(true)
  const build = grouped.locator(".fc-usage-row").filter({ hasText: /^build/ })
  await expect(build).toBeVisible()
  await expect(grouped.locator(".fc-usage-row").filter({ hasText: "explore" })).toBeVisible()

  // One interaction from the figure to whose price it is and how it was paid for.
  await build.locator(".fc-cost-figure").click()
  const basis = build.getByRole("note")
  await expect(basis).toContainText("Engine list price · pay per use")
  await expect(basis).toContainText("Engine list price · subscription")
  await page.keyboard.press("Escape")
  await expect(basis).toHaveCount(0)
})

test("the daily series draws money per lens, and a day opens its figure with its basis", async ({ page }) => {
  await open(page, "/cost")

  const days = page.locator(".fc-usage-day")
  await expect(days).toHaveCount(30)
  // Yesterday had pay-per-use and subscription money: two segments, never one merged bar.
  const yesterdayBar = days.nth(28)
  await expect(yesterdayBar.locator('.fc-usage-day-bar[data-lens="estimated"]')).toHaveCount(1)
  await expect(yesterdayBar.locator('.fc-usage-day-bar[data-lens="notional"]')).toHaveCount(1)
  // Today had unpriced calls, marked as such.
  await expect(days.nth(29).locator(".fc-usage-day-mark-on")).toHaveCount(1)

  await yesterdayBar.click()
  const detail = page.locator(".fc-usage-day-detail")
  await expect(detail).toContainText("Notional · Engine list price · subscription")
  await expect(detail).toContainText("Estimated · Engine list price · pay per use")
})

test("the same run costs the same on its card, in the Center and in its session", async ({ page }) => {
  await open(page, "/cost", "ses_task_a")
  const center = page
    .locator(".fc-usage-block")
    .filter({ has: page.locator("#fc-usage-runs") })
    .locator(".fc-usage-row")
    .filter({ hasText: "feature" })
    .locator(".fc-cost-figure")
  await expect(center).toHaveText("~$0.35$0.12 notional")
  const figure = (await center.textContent()) ?? ""

  await page.goto("/runs")
  const card = page.locator(".fc-run-card").filter({ hasText: "feature" })
  await expect(card.locator(".fc-run-head .fc-cost-figure")).toHaveText(figure)
  // The task's detail carries the same bill: the run had one task and nothing else.
  await card.locator(".fc-run-node").click()
  await expect(page.locator(".fc-run-detail .fc-cost-figure")).toHaveText(figure)
  await page.locator(".fc-run-detail").getByRole("button", { name: /^(Close|Cerrar)$/ }).click()

  await page.goto("/")
  await page.locator(".fc-context-button").click()
  const sessionRow = page.locator(".fc-context-spend .fc-context-row").filter({ hasText: /Session and 1 subagents|Sesión y 1 subagentes/ })
  await expect(sessionRow.locator(".fc-cost-figure")).toHaveText(figure)
  // The turn is the ledger's too: the turn's prompt was yesterday, so it is the whole session here.
  const turn = page.locator(".fc-context-spend .fc-context-row").filter({ hasText: /This turn|Este turno/ })
  await expect(turn.locator(".fc-cost-figure")).toHaveText(figure)
  // By agent, the subagent's share apart.
  await expect(page.locator(".fc-context-agent").filter({ hasText: "explore" })).toContainText("~$0.05")
})

// UL-08: a run's budget is a labelled meter of what the ledger says it spent, and a standing budget
// is set on the Cost screen and drawn the same way.
test("a run's budget is a meter on its card, and a day's budget is set on the Cost screen", async ({ page }) => {
  await open(page, "/runs")
  const meter = page.locator(".fc-run-card").filter({ hasText: "review" }).locator(".fc-budget-meter")
  await expect(meter).toHaveAttribute("data-level", "hard")
  await expect(meter.locator(".fc-budget-meter-label")).toHaveText("Budget (cost)")
  await expect(meter.locator(".fc-budget-meter-figure")).toHaveText("~$0.08 of $0.05")
  // The handoff on a local model had no price: the cost figure says it left it out.
  await expect(meter.locator(".fc-budget-meter-note")).toHaveText("1 unpriced model calls not counted")
  await expect(meter.getByRole("meter")).toHaveAttribute("aria-valuetext", "~$0.08 of $0.05")

  await page.goto("/cost")
  const block = page.locator(".fc-usage-block").filter({ has: page.locator("#fc-usage-budgets") })
  await block.locator(".fc-budget-form label", { hasText: "Limit" }).locator("input").fill("1")
  await block.getByRole("button", { name: "Add" }).click()
  const today = block.locator(".fc-budget-row .fc-budget-meter")
  await expect(today.locator(".fc-budget-meter-label")).toHaveText("Today's budget (cost)")
  // Today's spend, from the same ledger as the screen: a $0.02 compaction, and two local calls with
  // no price that a cost budget cannot count, said beside it.
  await expect(today.locator(".fc-budget-meter-figure")).toHaveText("~$0.02 of $1.00")
  await expect(today.locator(".fc-budget-meter-note")).toHaveText("2 unpriced model calls not counted")
  await expect(today).toHaveAttribute("data-level", "under")
  await block.getByRole("button", { name: "Remove" }).click()
  await expect(block.locator(".fc-budget-row")).toHaveCount(0)
})

test("a session the ledger has not heard of shows a dash, not $0", async ({ page }) => {
  await open(page, "/", "ses_unmeasured")
  await page.locator(".fc-context-button").click()
  const spend = page.locator(".fc-context-spend")
  await expect(spend.locator(".fc-context-row").filter({ hasText: /This turn|Este turno/ })).toContainText("—")
  await expect(spend.locator(".fc-context-row").filter({ hasText: /^(Session|Sesión)/ })).toContainText("—")
  await expect(spend).not.toContainText("$0")
})
