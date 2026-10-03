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
  status: "completed",
  reason,
  summary,
  recent: "",
  time: { created },
})
const history = [
  user("u1", "Haz A y B", now),
  assistant("a1", "Hecha A.", now + 1),
  compaction("c1", "manual", "## Resumen\n\n- A quedó hecha.", now + 10),
  user("u2", "Sigue", now + 20),
  assistant("a2", "Voy.", now + 21),
  compaction("c2", "auto", "## Resumen\n\n- A y B hechas.", now + 30),
]

async function openSession(page: Page, messages: unknown[] = history, live?: { events: unknown[] }) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_compact"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: live ? { ses_compact: { type: "running" } } : {} } })
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
    if (url.pathname === "/api/session/ses_compact/message")
      // The engine pages its transcript newest first.
      return route.fulfill({ json: { data: [...messages].reverse(), cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: (live?.events ?? []).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  // The panel opens itself for work, and these sessions have none: the meter tests ask for it.
  await page.getByRole("button", { name: /Toggle details panel|Alternar panel de detalles/ }).click()
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

// A fold is a turn of its own, so without a word of its own the status line under the conversation
// reads like the agent working on the task. An automatic one starts with no request from the reader.
test("a session the engine starts folding on its own says so", async ({ page }) => {
  await openSession(page, [user("u1", "Haz A y B", now), assistant("a1", "Hecha A.", now + 1)], {
    events: [
      {
        id: "evt_1",
        created: now + 5,
        type: "session.compaction.started",
        durable: { aggregateID: "ses_compact", seq: 1, version: 1 },
        data: { sessionID: "ses_compact", reason: "auto", recent: "" },
      },
    ],
  })

  await expect(page.locator(".fc-message-pending")).toContainText(/Compacting session|Compactando sesión/)
})

test("a turn after the fold reads as thinking again", async ({ page }) => {
  await openSession(page, [
    user("u1", "Haz A y B", now),
    assistant("a1", "Hecha A.", now + 1),
    compaction("c1", "auto", "## Resumen\n\n- A quedó hecha.", now + 6),
    {
      ...assistant("a3", "", now + 20),
      time: { created: now + 20 },
      // Reasoning that started and has not completed is still being written.
      content: [{ type: "reasoning", text: "…", time: { created: now + 20 } }],
    },
  ])

  await expect(page.locator(".fc-message-pending")).toContainText(/Thinking|Pensando/)
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

/** The meter lives in the composer's popover: the right panel is for watching work. */
const openMeter = async (page: Page) => {
  await page.locator(".fc-context-button").click()
  return page.locator(".fc-context-popover")
}

test("the meter sizes the session the compaction left, not the history it folded", async ({ page }) => {
  await openSession(page, compacted)

  const value = (await openMeter(page)).locator(".fc-context-strong")
  await expect(value).toContainText("~")
  await expect(value).toHaveAttribute("title", /Estimated|Estimado/)
  // 11.1k is the wrap the first step paid plus the summary the engine kept; the 474.0k the summary
  // itself reports is the request that wrote it, not what the next prompt will send.
  await expect(value).toContainText("11.1k")
})

test("a step after the compaction measures the session again", async ({ page }) => {
  await openSession(page, [...compacted, assistant("a2", "Voy.", now + 20, { input: 10_000, read: 11_000 })])

  const value = (await openMeter(page)).locator(".fc-context-strong")
  await expect(value).toContainText("21.0k")
  await expect(value).not.toContainText("~")
})

// The engine folds a session at its own point — the window less the room it keeps for the answer —
// which is a good deal before the model's own limit is reached.
const turn = (input: number, read: number) => [user("u1", "Haz A y B", now), assistant("a1", "Hecho.", now + 1, { input, read })]

test("warns before the engine folds the session, and says how much room is left", async ({ page }) => {
  await openSession(page, turn(120_000, 60_000))

  // 180k counted against a 200k window that keeps 8k for the answer.
  await expect(page.locator(".fc-context")).toHaveClass(/fc-context-near/)
  const popover = await openMeter(page)
  await expect(popover.locator(".fc-context-compaction")).toContainText("192.0k")
  await expect(popover.locator(".fc-context-compaction")).toContainText(/12.0k (left|restantes)/)
})

test("says the engine folds it now once the budget is gone", async ({ page }) => {
  await openSession(page, turn(470_000, 4_000))

  const popover = await openMeter(page)
  await expect(popover.locator(".fc-context-compaction")).toContainText(/next step|siguiente paso/)
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
