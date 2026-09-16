import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_md",
  projectID: "p",
  title: "Markdown",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const answer = [
  "Here is the plan.",
  "",
  "1. Read `src/app.tsx`",
  "2. Patch the reducer",
  "",
  "```ts",
  "export function applyDelta(data: Message[]) {",
  "  return data.map((message) => message)",
  "}",
  "```",
].join("\n")

const legacy = [
  {
    info: { id: "u", sessionID: "ses_md", role: "user", time: { created: now } },
    parts: [{ id: "pu", type: "text", text: "Plan it" }],
  },
  {
    info: { id: "a", sessionID: "ses_md", role: "assistant", agent: "build", time: { created: now + 1 } },
    parts: [{ id: "pa", type: "text", text: answer, time: { start: now + 1, end: now + 2 } }],
  },
]

test("the transcript renders markdown with real syntax highlighting", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_md"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_md/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: legacy })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const markdown = page.locator('.fc-message-assistant [data-component="markdown"]').first()
  await expect(markdown).toBeVisible()
  await expect(page.getByText("Patch the reducer")).toBeVisible()

  // A real ordered list, not a paragraph starting with "1.".
  await expect(markdown.locator("ol > li")).toHaveCount(2)

  // The code block is tokenised rather than run through a handful of regexes: several distinct
  // colours, and they are the harness's own palette because the highlighter's theme is CSS
  // variables that map onto it.
  const colours = await markdown
    .locator("pre span[style*='color']")
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).color))])
  expect(colours.length).toBeGreaterThan(2)
})

test("what the model thought is one click away instead of gone", async ({ page }) => {
  const thinking = "First I check the reducer, then the store."
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_md"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_md/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname))
      return route.fulfill({
        json: [
          legacy[0],
          {
            info: { id: "a", sessionID: "ses_md", role: "assistant", agent: "build", time: { created: now + 1 } },
            parts: [
              { id: "pr", type: "reasoning", text: thinking, time: { start: now + 1, end: now + 2 } },
              { id: "pa", type: "text", text: "Done.", time: { start: now + 2, end: now + 3 } },
            ],
          },
        ],
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Done.")).toBeVisible()
  // Closed by default: the conversation still reads as the answer alone.
  await expect(page.getByText(thinking)).toHaveCount(0)

  await page.locator(".fc-reasoning .fc-toolgroup-line").click()
  await expect(page.getByText(thinking)).toBeVisible()
})
