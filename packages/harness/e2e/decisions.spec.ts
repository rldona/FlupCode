import { expect, test, type Page } from "@playwright/test"

/**
 * The decision audit as a reader uses it (AH-E05): filters, pages, readable rows, and a decision a
 * link focuses. The server here keeps 10,000 decisions, which is what the audit reaches after a few
 * weeks of relevance decisions without retention.
 */

const now = Date.now()
const TOTAL = 10_000

const session = {
  id: "ses_dec",
  projectID: "p",
  title: "Decisions",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const KINDS = ["completion", "skillRelevance", "contextItem"]

// Row 0 acted, so the unfiltered list and the "Only recorded" one start with different pills.
const decisions = Array.from({ length: TOTAL }, (_, index) => ({
  id: `d:${String(index).padStart(5, "0")}`,
  kind: KINDS[index % KINDS.length],
  sessionID: "ses_dec",
  inputsHash: "h",
  stateSummary: {},
  answer: true,
  baselineAnswer: true,
  baselineRule: "default",
  confidence: 0.82,
  provider: "jev",
  source: index % 5 === 0 ? "model" : "baseline",
  degraded: false,
  latencyMs: 12,
  shadow: index % 2 === 1,
  createdAt: now - index * 1000,
  updatedAt: now - index * 1000,
}))

/** The registry the settings view serves (AH-C01): what a model id is called for a reader. */
const REGISTRY = [
  { id: "jev", name: "Jev", locality: "remote", supports: ["completion"], needsConsent: true, needsKey: true },
  { id: "small-llm", name: "Small model (through the engine)", locality: "remote", supports: ["completion"], needsConsent: true, needsKey: false },
]

type Server = {
  /** Answers every list with the whole filtered audit, the way a server before AH-E05 did. */
  unpaged?: boolean
  /** Announces the settings surface, whose view serves the model registry with display names. */
  registry?: boolean
  queries: URLSearchParams[]
}

async function openApp(page: Page, server: Server) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    // No session selected: the audit lists every session's decisions.
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({
        json: {
          data: { healthy: true, capabilities: ["adaptive-decisions", ...(server.registry ? ["adaptive-config"] : [])] },
        },
      })
    if (url.pathname === "/harness/adaptive/config") return route.fulfill({ json: { data: { models: REGISTRY } } })
    if (url.pathname === "/harness/adaptive/decisions") {
      server.queries.push(url.searchParams)
      return route.fulfill({ json: listDecisions(url.searchParams, server.unpaged ?? false) })
    }
    if (url.pathname.startsWith("/harness/adaptive/decisions/")) {
      const id = decodeURIComponent(url.pathname.slice("/harness/adaptive/decisions/".length))
      return route.fulfill({
        json: {
          data: {
            id,
            question: "Is this complete?",
            answer: true,
            baseline: { answer: true, rule: "default" },
            why: "the tests passed",
            source: "model",
            provider: "jev",
            confidence: 0.82,
            latencyMs: 12,
            degraded: false,
            evidenceRefs: [],
            decidedAt: now,
          },
        },
      })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/mcp" || url.pathname === "/config") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
}

/** The server's contract: filter, then keyset-page newest first with one row to spare. */
function listDecisions(params: URLSearchParams, unpaged: boolean) {
  const acted = params.get("acted")
  const before = params.get("before")
  const cut = before ? { createdAt: Number(before.split(",")[0]), id: before.slice(before.indexOf(",") + 1) } : undefined
  const filtered = decisions.filter(
    (decision) =>
      (!params.get("id") || decision.id === params.get("id")) &&
      (!params.get("kind") || decision.kind === params.get("kind")) &&
      (acted === null || (acted === "true") === !decision.shadow) &&
      (!cut ||
        decision.createdAt < cut.createdAt ||
        (decision.createdAt === cut.createdAt && decision.id < cut.id)),
  )
  const limit = params.get("limit")
  if (unpaged || limit === null) return { data: filtered }
  const data = filtered.slice(0, Number(limit))
  const last = data.at(-1)
  return {
    data,
    ...(filtered.length > data.length && last ? { nextCursor: `${last.createdAt},${last.id}` } : {}),
  }
}

const rows = (page: Page) => page.locator(".fc-decision-row")

test("10,000 decisions paint one page in under 200 ms, even from a server that sends them all", async ({ page }) => {
  const server: Server = { unpaged: true, queries: [] }
  await openApp(page, server)
  await page.goto("/decisions")
  await expect(rows(page)).toHaveCount(50)
  await expect(page.locator(".fc-usage-block h2", { hasText: "Recorded decisions" })).toContainText(String(TOTAL))

  // From the click to the new page painted: the fetch, the 10,000-row answer, and the render.
  const elapsed = await page.evaluate(async () => {
    const pill = [...document.querySelectorAll("button")].find((button) => button.textContent === "Only recorded")!
    const start = performance.now()
    pill.click()
    await new Promise<void>((resolve) => {
      const painted = () => {
        const first = document.querySelector(".fc-decision-row .fc-decision-pill")
        if (first?.textContent === "Only recorded" && document.querySelectorAll(".fc-decision-row").length === 50)
          return resolve()
        requestAnimationFrame(painted)
      }
      painted()
    })
    return performance.now() - start
  })
  expect(elapsed).toBeLessThan(200)
  await expect(rows(page)).toHaveCount(50)

  // "Load more" paints the next rows it already has, without asking the server again.
  const asked = server.queries.length
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(rows(page)).toHaveCount(100)
  expect(server.queries.length).toBe(asked)
})

test("pages with the cursor, and filters by capability and by whether the harness acted", async ({ page }) => {
  const server: Server = { queries: [] }
  await openApp(page, server)
  await page.goto("/decisions")

  await expect(rows(page)).toHaveCount(50)
  expect(server.queries.at(-1)?.get("limit")).toBe("50")
  const heading = page.locator(".fc-usage-block h2", { hasText: "Recorded decisions" })
  await expect(heading).toContainText("50+")

  await page.getByRole("button", { name: "Load more" }).click()
  await expect(rows(page)).toHaveCount(100)
  expect(server.queries.at(-1)?.get("before")).toBe(`${decisions[49]!.createdAt},${decisions[49]!.id}`)
  await expect(heading).toContainText("100+")

  // Readable titles, not raw kinds, and confidence as a band with its number.
  const first = rows(page).first()
  await expect(first).toContainText("Is the task done")
  await expect(first).not.toContainText("completion")
  await expect(first).toContainText("High (82%)")
  await expect(first).toContainText("Acted")
  await expect(rows(page).nth(1)).toContainText("Only recorded")

  await page.getByRole("combobox", { name: "Capability" }).selectOption("skillRelevance")
  await expect(rows(page)).toHaveCount(50)
  await expect(rows(page).first()).toContainText("Which skills fit")
  expect(server.queries.at(-1)?.get("kind")).toBe("skillRelevance")
  expect(server.queries.at(-1)?.get("before")).toBeNull()

  const acted = page.getByRole("button", { name: "Acted", exact: true })
  await acted.click()
  await expect(acted).toHaveAttribute("aria-pressed", "true")
  expect(server.queries.at(-1)?.get("acted")).toBe("true")
  await expect(rows(page).filter({ hasText: "Only recorded" })).toHaveCount(0)
})

test("the dialog is titled by what was decided, and keeps the id under Advanced", async ({ page }) => {
  await openApp(page, { queries: [] })
  await page.goto("/decisions")
  await rows(page).first().click()

  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog.locator(".fc-modal-heading")).toHaveText("Is the task done")
  await expect(dialog).toContainText("the tests passed")
  await expect(dialog).toContainText("High (82%)")
  const id = dialog.getByText("d:00000", { exact: true })
  await expect(id).toBeHidden()
  await dialog.getByText("Advanced").click()
  await expect(id).toBeVisible()
})

test("the row and the dialog name the model by its registry name, and the raw id only without a registry", async ({
  page,
}) => {
  await openApp(page, { queries: [], registry: true })
  await page.goto("/decisions")
  await expect(rows(page).first()).toContainText("· Jev")
  await expect(rows(page).first()).not.toContainText("jev")
  await rows(page).first().click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog.locator(".fc-usage-row").filter({ hasText: "Provider" })).toContainText("Jev")
  await expect(dialog).not.toContainText(/\bjev\b/)
})

test("a link to a decision on the page scrolls to it and highlights it", async ({ page }) => {
  await openApp(page, { queries: [] })
  await page.goto("/decisions?decision=d:00030")

  const row = page.locator('.fc-decision-row[data-decision-id="d:00030"]')
  await expect(row).toHaveAttribute("aria-current", "true")
  await expect(row).toBeInViewport()
  // The link opens the decision's dialog, which holds the focus; closing it lands on the row (AH-E06).
  await expect(page.getByRole("dialog", { name: "Decision" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(row).toBeFocused()
  await expect(page.getByText("Linked decision")).toHaveCount(0)
})

test("a link to a decision beyond the page reads it by id and pins it above the list", async ({ page }) => {
  const server: Server = { queries: [] }
  await openApp(page, server)
  await page.goto("/decisions?decision=d:09999")

  const pinned = page.locator(".fc-usage-block", { hasText: "Linked decision" })
  const row = pinned.locator('.fc-decision-row[data-decision-id="d:09999"]')
  await expect(row).toHaveAttribute("aria-current", "true")
  await expect(page.getByRole("dialog", { name: "Decision" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(row).toBeFocused()
  expect(server.queries.some((query) => query.get("id") === "d:09999")).toBe(true)
  await expect(rows(page)).toHaveCount(51)
})

test("a link to a decision the audit no longer has says so", async ({ page }) => {
  await openApp(page, { queries: [] })
  await page.goto("/decisions?decision=d:gone")
  await expect(page.getByText("That decision is no longer in the audit.")).toBeVisible()
  await expect(rows(page)).toHaveCount(50)
})
