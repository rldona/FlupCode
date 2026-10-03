import { expect, test, type Page } from "@playwright/test"

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
  "The **reducer** drives it and the *store* follows.",
  "",
  "## Next steps",
  "",
  "```ts",
  "export function applyDelta(data: Message[]) {",
  "  return data.map((message) => message)",
  "}",
  "```",
].join("\n")

const prompt = { id: "u", type: "user", text: "Plan it", time: { created: now } }
const reply = (content: unknown[]) => ({
  id: "a",
  type: "assistant",
  agent: "build",
  model: { providerID: "openai", id: "gpt" },
  content,
  time: { created: now + 1, completed: now + 3 },
})

test("the transcript renders markdown with real syntax highlighting", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_md"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    // The engine pages its transcript newest first.
    if (url.pathname === "/api/session/ses_md/message")
      return route.fulfill({ json: { data: [reply([{ type: "text", text: answer }]), prompt], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
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

  // The code block carries its own copy button, which says it copied.
  const copy = markdown.locator('[data-component="markdown-code"] [data-slot="markdown-copy-button"] button')
  await expect(copy).toHaveCount(1)
  await expect(copy).toHaveAttribute("aria-label", /^(Copy|Copiar)$/)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await markdown.locator('[data-component="markdown-code"]').hover()
  await copy.click()
  await expect(copy).toHaveAttribute("aria-label", /^(Copied|Copiado)$/)

  // Prose markdown carries the TUI's semantic colours: inline code green, bold/italic warm,
  // headings accent — all resolved from the harness palette, in light and dark.
  const resolved = (token: string) =>
    page.evaluate((name) => {
      const probe = document.createElement("span")
      probe.style.color = `var(${name})`
      document.body.appendChild(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    }, token)
  const proseColours = async () => ({
    inlineCode: await markdown.locator(":not(pre) > code").first().evaluate((node) => getComputedStyle(node).color),
    strong: await markdown.locator("strong").first().evaluate((node) => getComputedStyle(node).color),
    emphasis: await markdown.locator("em").first().evaluate((node) => getComputedStyle(node).color),
    heading: await markdown.locator("h2").first().evaluate((node) => getComputedStyle(node).color),
  })
  const light = await proseColours()
  expect(light.inlineCode).toBe(await resolved("--fc-syn-string"))
  expect(light.strong).toBe(await resolved("--fc-warning"))
  expect(light.emphasis).toBe(await resolved("--fc-warning"))
  expect(light.heading).toBe(await resolved("--fc-accent"))

  await page.evaluate(() => document.documentElement.classList.add("fc-dark"))
  const dark = await proseColours()
  expect(dark.inlineCode).toBe(await resolved("--fc-syn-string"))
  expect(dark.strong).toBe(await resolved("--fc-warning"))
  expect(dark.emphasis).toBe(await resolved("--fc-warning"))
  expect(dark.heading).toBe(await resolved("--fc-accent"))
})

const thinking = "First I check the reducer, then the store."

async function openThinkingSession(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_md"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_md/message")
      return route.fulfill({
        json: {
          data: [
            reply([
              { type: "reasoning", text: thinking, time: { created: now + 1, completed: now + 2 } },
              { type: "text", text: "Done." },
            ]),
            prompt,
          ],
          cursor: {},
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.getByText("Done.")).toBeVisible()
}

test("the model's thinking stays out of the conversation until it is asked for", async ({ page }) => {
  await openThinkingSession(page)

  // Off by default, as in Claude Code: not even the block that would open it.
  await expect(page.locator(".fc-reasoning")).toHaveCount(0)
  await expect(page.getByText(thinking)).toHaveCount(0)
})

test("turning thinking on in Settings puts it back, closed", async ({ page }) => {
  await openThinkingSession(page)

  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  await page.getByRole("tab", { name: /Conversation|Conversación/ }).click()
  await page
    .locator(".fc-settings-row")
    .filter({ hasText: /Show thinking|Mostrar el razonamiento/ })
    .getByRole("switch")
    .click()
  await page
    .getByRole("button", { name: /^Close$|^Cerrar$/ })
    .first()
    .click()

  // Still closed, so the conversation reads as the answer alone; one click opens it.
  await expect(page.locator(".fc-reasoning")).toBeVisible()
  await expect(page.getByText(thinking)).toHaveCount(0)
  await page.locator(".fc-reasoning .fc-toolgroup-line").click()
  await expect(page.getByText(thinking)).toBeVisible()
})
