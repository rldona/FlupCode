import { expect, test, type Page } from "@playwright/test"

// ── AH-E02: the composer's "Adaptive" chip and the per-session override ───────────────────────

const now = Date.now()

const session = {
  id: "ses_ad",
  projectID: "p",
  title: "Adaptive",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const turn = {
  relevance: { decisionID: "skillRelevance:ses_ad:msg_1", skills: ["testing", "parser"], acted: true, at: now },
  plan: { id: "plan:run_1:task_1", tokensSaved: 1200, applied: true, at: now },
  model: {
    providerID: "jev",
    kind: "skillRelevance",
    latencyMs: 180,
    decisionID: "skillRelevance:ses_ad:msg_1",
    at: now,
  },
}

type Calls = { turns: string[]; puts: Array<{ path: string; body: unknown }>; explained: string[] }

/** The harness against a mocked server and engine, with no network at all. */
async function openApp(page: Page, capabilities: string[]) {
  const calls: Calls = { turns: [], puts: [], explained: [] }
  let override = { paused: false, excludedSkills: [] as string[] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_ad"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true, capabilities } } })
    if (url.pathname === "/harness/context")
      return route.fulfill({
        json: { data: { directory: "/work/demo", projectDirectory: "/work/demo", instructions: [] } },
      })
    if (url.pathname === "/harness/adaptive/sessions/ses_ad/turn") {
      calls.turns.push(url.pathname)
      return route.fulfill({ json: { data: { sessionID: "ses_ad", override, ...turn } } })
    }
    if (url.pathname === "/harness/adaptive/sessions/ses_ad/override" && request.method() === "PUT") {
      const body = request.postDataJSON() as Partial<typeof override>
      calls.puts.push({ path: url.pathname, body })
      override = { ...override, ...body }
      return route.fulfill({ json: { data: override } })
    }
    // The chip's "Why?" links to the decision, which the screen reads by id.
    if (url.pathname === "/harness/adaptive/decisions")
      return route.fulfill({
        json: {
          data: [
            {
              id: "skillRelevance:ses_ad:msg_1",
              kind: "relevance",
              inputsHash: "h",
              stateSummary: {},
              answer: {},
              baselineAnswer: {},
              baselineRule: "default",
              source: "baseline",
              degraded: false,
              latencyMs: 3,
              shadow: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        },
      })
    if (url.pathname.startsWith("/harness/adaptive/decisions/")) {
      const id = decodeURIComponent(url.pathname.slice("/harness/adaptive/decisions/".length))
      calls.explained.push(id)
      return route.fulfill({
        json: {
          data: {
            id,
            question: "Which skills should be loaded for this objective?",
            answer: { load: ["testing", "parser"] },
            baseline: { answer: { load: ["testing"] }, rule: "lexical-objective-match" },
            why: "jev answered, clearing the policy thresholds.",
            source: "model",
            provider: "jev",
            latencyMs: 180,
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/experimental/tool/ids") return route.fulfill({ json: ["bash", "read", "edit"] })
    if (url.pathname === "/api/skill") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/mcp") return route.fulfill({ json: {} })
    if (url.pathname === "/config") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  return calls
}

const chip = (page: Page) => page.locator(".fc-composer .fc-adaptive-chip")

test("a server without adaptive-session shows no chip and is never asked", async ({ page }) => {
  const calls = await openApp(page, ["adaptive-decisions"])
  await page.goto("/")

  await expect(page.locator(".fc-composer")).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  expect(calls.turns).toEqual([])
})

test("the chip shows the turn's suggested skills, the applied plan and the model consulted", async ({ page }) => {
  await openApp(page, ["adaptive-session", "adaptive-decisions"])
  await page.goto("/")

  const button = chip(page).getByRole("button", { name: "Adaptive" })
  await expect(button).toBeVisible()
  await button.click()
  const popover = page.getByRole("dialog", { name: "Adaptive on this turn" })
  await expect(popover).toBeVisible()
  await expect(popover).toContainText("testing")
  await expect(popover).toContainText("parser")
  await expect(popover).toContainText(`Context plan applied: −${(1200).toLocaleString("en-US")} tokens`)
  await expect(popover).toContainText("Consulted jev (180 ms)")

  // Escape closes it and hands the focus back to the chip.
  await page.keyboard.press("Escape")
  await expect(popover).toHaveCount(0)
  await expect(button).toBeFocused()
})

test("pause in this session writes the override and the chip says so", async ({ page }) => {
  const calls = await openApp(page, ["adaptive-session"])
  await page.goto("/")

  await chip(page).getByRole("button", { name: "Adaptive" }).click()
  const popover = page.getByRole("dialog", { name: "Adaptive on this turn" })
  await popover.getByRole("button", { name: "Pause in this session" }).click()
  await expect
    .poll(() => calls.puts)
    .toEqual([{ path: "/harness/adaptive/sessions/ses_ad/override", body: { paused: true } }])
  await expect(chip(page).getByRole("button", { name: "Adaptive · paused" })).toBeVisible()
  await expect(popover.getByRole("status")).toContainText("Paused in this session")

  await popover.getByRole("button", { name: "Resume in this session" }).click()
  await expect.poll(() => calls.puts.at(-1)?.body).toEqual({ paused: false })
  await expect(chip(page).getByRole("button", { name: "Adaptive", exact: true })).toBeVisible()
})

test("don't suggest a skill excludes it for this session, and it can be suggested again", async ({ page }) => {
  const calls = await openApp(page, ["adaptive-session"])
  await page.goto("/")

  await chip(page).getByRole("button", { name: "Adaptive" }).click()
  const popover = page.getByRole("dialog", { name: "Adaptive on this turn" })
  await popover.getByRole("button", { name: "Don't suggest testing" }).click()
  await expect.poll(() => calls.puts.at(-1)?.body).toEqual({ excludedSkills: ["testing"] })
  const excluded = popover.getByRole("region", { name: "Not suggested in this session" })
  await expect(excluded).toContainText("testing")

  await excluded.getByRole("button", { name: "Suggest testing again" }).click()
  await expect.poll(() => calls.puts.at(-1)?.body).toEqual({ excludedSkills: [] })
  await expect(excluded).toHaveCount(0)
})

test("why? opens the decision behind the turn in the Decisions screen", async ({ page }) => {
  const calls = await openApp(page, ["adaptive-session", "adaptive-decisions"])
  await page.goto("/")

  await chip(page).getByRole("button", { name: "Adaptive" }).click()
  await page.getByRole("dialog", { name: "Adaptive on this turn" }).getByRole("button", { name: "Why?" }).click()

  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Which skills should be loaded for this objective?")
  expect(calls.explained).toContain("skillRelevance:ses_ad:msg_1")
})
