import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_compact",
  projectID: "p",
  title: "Compaction",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const user = (id: string, text: string, created: number) => ({
  id,
  sessionID: "ses_compact",
  type: "user",
  text,
  time: { created, completed: created },
})
const assistant = (id: string, text: string, created: number, tokens?: { input: number; read: number }) => ({
  id,
  sessionID: "ses_compact",
  type: "assistant",
  agent: "build",
  model: { providerID: "openai", id: "gpt" },
  cost: 0,
  tokens: {
    input: tokens?.input ?? 0,
    output: 0,
    reasoning: 0,
    cache: { read: tokens?.read ?? 0, write: 0 },
  },
  time: { created, completed: created + 1 },
  content: [{ type: "text", id: `${id}_p`, text }],
})
/** What the engine writes when a session is compacted, in v2's own message type. */
const compaction = (id: string, reason: "auto" | "manual", summary: string, created: number) => ({
  id,
  sessionID: "ses_compact",
  type: "compaction",
  reason,
  summary,
  recent: "",
  time: { created },
})
/** A turn the engine pruned: `compaction.prune` marks the result it cleared, and only the legacy
 *  store carries that mark — it is the store every FlupCode turn is written to. */
const clearedTurn = [
  {
    info: { id: "l1", sessionID: "ses_compact", role: "user", time: { created: now } },
    parts: [{ id: "l1p", type: "text", text: "Lee el log" }],
  },
  {
    info: { id: "l2", sessionID: "ses_compact", role: "assistant", agent: "build", time: { created: now + 1 } },
    parts: [
      {
        id: "l2t",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "cat big.log" },
          output: "3 líneas",
          time: { start: now, end: now, compacted: now + 2 },
        },
      },
    ],
  },
]

const history = [
  user("u1", "Haz A y B", now),
  assistant("a1", "Hecha A.", now + 1),
  compaction("c1", "manual", "## Resumen\n\n- A quedó hecha.", now + 10),
  user("u2", "Sigue", now + 20),
  assistant("a2", "Voy.", now + 21),
  compaction("c2", "auto", "## Resumen\n\n- A y B hechas.", now + 30),
]

async function openSession(page: Page, messages = history, legacy: unknown[] = []) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_compact"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    // A 200k window whose answers can run to 8k: the engine folds the session at 192k.
    if (url.pathname === "/api/model")
      return route.fulfill({
        json: {
          data: [
            {
              id: "gpt",
              providerID: "openai",
              name: "GPT",
              limit: { context: 200_000, output: 8_000 },
              cost: [],
              status: "active",
              enabled: true,
              variants: [],
            },
          ],
        },
      })
    if (url.pathname === "/config") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_compact/message")
      return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: legacy })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  // The panel opens itself for work, and these sessions have none: the meter tests ask for it.
  await page.getByRole("button", { name: /Toggle context panel|Alternar panel de contexto/ }).click()
}

test("a compaction is a marked boundary, not one more answer", async ({ page }) => {
  await openSession(page)

  const markers = page.locator(".fc-compaction")
  await expect(markers).toHaveCount(2)
  // A manual compaction says so; one the engine chose reads quieter.
  await expect(markers.nth(0)).toContainText(/Session compacted|Sesión compactada/)
  await expect(markers.nth(1)).toContainText(/Compacted automatically|Compactada automáticamente/)
  await expect(markers.nth(0)).toHaveAttribute("data-auto", "false")
  await expect(markers.nth(1)).toHaveAttribute("data-auto", "true")

  // The summary stays behind the toggle until it is asked for.
  await expect(markers.nth(0).locator(".fc-compaction-body")).toHaveCount(0)
  await markers.nth(0).locator(".fc-compaction-line").click()
  await expect(markers.nth(0).locator(".fc-compaction-body")).toContainText("A quedó hecha")
})

// A session that was compacted and not prompted again: the last thing the engine measured is the
// history it folded away, so the meter has no step to read the compacted session from.
const compacted = [
  user("u1", "Haz A y B", now),
  // The first step's whole prompt was that ten-character ask, so what it reads beyond it is the
  // system prompt and tools — the cost every later prompt carries too.
  assistant("a1", "Hecha A.", now + 1, { input: 11_053, read: 0 }),
  assistant("a2", "Y B.", now + 2, { input: 470_000, read: 4_000 }),
  compaction("c1", "manual", "## Resumen\n\n- A quedó hecha.", now + 10),
]

const contextTokens = (page: Page) => page.locator(".fc-aside-section").first().locator(".fc-aside-row span").first()

test("the meter sizes the session the compaction left, not the history it folded", async ({ page }) => {
  await openSession(page, compacted)

  await expect(contextTokens(page)).toContainText("~")
  await expect(contextTokens(page)).toHaveAttribute("title", /Estimated|Estimado/)
  // 11.1k is the wrap the first step paid plus the summary the engine kept; the 474.0k the summary
  // itself reports is the request that wrote it, not what the next prompt will send.
  await expect(contextTokens(page)).toContainText("11.1k")
})

test("a step after the compaction measures the session again", async ({ page }) => {
  await openSession(page, [...compacted, assistant("a2", "Voy.", now + 20, { input: 10_000, read: 11_000 })])

  await expect(contextTokens(page)).toContainText("21.0k")
  await expect(contextTokens(page)).not.toContainText("~")
})

test("a cleared tool result says the engine dropped it from the context", async ({ page }) => {
  await openSession(page, [], clearedTurn)

  // The block is closed, and still says how much of it left the context.
  const group = page.locator(".fc-toolgroup")
  await expect(group.locator(".fc-toolgroup-cleared")).toContainText(/1 cleared|1 borrados/)
  await group.locator(".fc-toolgroup-line").click()

  const tool = page.locator(".fc-tool")
  await expect(tool).toHaveClass(/fc-tool-cleared/)
  await expect(tool.locator(".fc-tool-cleared-badge")).toContainText(/Cleared from context|Borrado del contexto/)
})

// The engine folds a session at its own point — the window less the room it keeps for the answer —
// which is a good deal before the model's own limit is reached.
const turn = (input: number, read: number) => [user("u1", "Haz A y B", now), assistant("a1", "Hecho.", now + 1, { input, read })]

test("warns before the engine folds the session, and says how much room is left", async ({ page }) => {
  await openSession(page, turn(120_000, 60_000))

  // 180k counted against a 200k window that keeps 8k for the answer.
  const aside = page.locator(".fc-aside-section").first()
  await expect(aside.locator(".fc-aside-compaction")).toContainText("192.0k")
  await expect(aside.locator(".fc-meter")).toHaveClass(/fc-meter-near/)

  await page.locator(".fc-context-button").click()
  const popover = page.locator(".fc-context-popover")
  await expect(popover.locator(".fc-context-compaction")).toContainText(/12.0k (left|restantes)/)
})

test("says the engine folds it now once the budget is gone", async ({ page }) => {
  await openSession(page, turn(470_000, 4_000))

  const aside = page.locator(".fc-aside-compaction")
  await expect(aside).toContainText(/next step|siguiente paso/)
  await page.locator(".fc-context-button").click()
  await expect(page.locator(".fc-context-popover")).toContainText(/next step|siguiente paso/)
})

test("the meter's figures read as a list, not as a table of ruled rows", async ({ page }) => {
  await openSession(page, turn(120_000, 60_000))
  await page.locator(".fc-context-button").click()

  // The inspector's rows are buttons and carry a rule under them; that rule used to reach the
  // popover too, drawing a line under every figure.
  const row = page.locator(".fc-context-popover .fc-context-row").first()
  await expect(row).toBeVisible()
  expect(await row.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe("0px")
})
