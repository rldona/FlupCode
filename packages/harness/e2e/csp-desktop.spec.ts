import { expect, test, type Page } from "@playwright/test"
import { rendererCsp } from "../../harness-desktop/src/main/renderer-csp"

// The desktop app serves this same build from `oc://renderer` under its own policy (TI-17): the hosted
// one, except that the page may only connect to loopback and the relay. These run the real build
// under that policy, so a directive too tight for what the app loads shows up here and not in a
// user's window.
const RELAY = "wss://relay.flupcode.test"
const now = Date.now()
const session = {
  id: "ses_csp",
  projectID: "p",
  title: "Policy",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}
const answer = [
  "The **chart** is below.",
  "",
  "![chart](https://images.example.test/chart.png)",
  "",
  "```ts",
  "export const answer = 42",
  "```",
].join("\n")
// The smallest valid PNG: one transparent pixel.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

test.use({ serviceWorkers: "block" })

async function openDesktopApp(page: Page) {
  await page.addInitScript(() => {
    const violations: { blocked: string; directive: string }[] = []
    Object.defineProperty(window, "cspViolations", { value: violations })
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push({ blocked: event.blockedURI, directive: event.effectiveDirective }),
    )
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_csp"))
  })
  // Every file the build serves carries the policy, as the protocol handler does: the markdown
  // worker is governed by the one its own script arrives with.
  await page.route("http://localhost:4173/**", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": rendererCsp(RELAY) },
    })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_csp/message")
      return route.fulfill({
        json: {
          data: [
            {
              id: "a",
              type: "assistant",
              agent: "build",
              model: { providerID: "openai", id: "gpt" },
              content: [{ type: "text", text: answer }],
              time: { created: now + 1, completed: now + 3 },
            },
            { id: "u", type: "user", text: "Draw it", time: { created: now } },
          ],
          cursor: {},
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("https://images.example.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
  )
  await page.goto("/")
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { cspViolations: { blocked: string; directive: string }[] }).cspViolations)

test("the app, its markdown worker and a remote image all load under the desktop policy", async ({ page }) => {
  await openDesktopApp(page)

  const markdown = page.locator('.fc-message-assistant [data-component="markdown"]').first()
  await expect(markdown).toBeVisible()
  // Rendered and highlighted: the worker that does both started and compiled its WebAssembly. A
  // refusal there happens inside the worker, so the page's violation listener never hears of it.
  await expect
    .poll(() => markdown.locator("pre span[style*='color']").count(), { timeout: 10_000 })
    .toBeGreaterThan(1)
  // The image came through `img-src https:` and decoded.
  const image = markdown.locator('img[alt="chart"]')
  await expect(image).toHaveCount(1)
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)

  expect(await violations(page)).toEqual([])
})

test("the page reaches loopback and the relay, and no other origin", async ({ page }) => {
  await openDesktopApp(page)
  await expect(page.locator('.fc-message-assistant [data-component="markdown"]').first()).toBeVisible()

  const elsewhere: string[] = []
  await page.route("https://example.com/**", (route) => {
    elsewhere.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.route("https://relay.flupcode.test/**", (route) => route.fulfill({ json: { publicKey: "k" } }))

  const outcome = await page.evaluate(async () => {
    const reach = (url: string) =>
      fetch(url).then(
        (response) => response.status,
        () => "blocked",
      )
    return {
      loopback: await reach("http://127.0.0.1:9/api/info"),
      relay: await reach("https://relay.flupcode.test/push/key"),
      elsewhere: await reach("https://example.com/collect"),
    }
  })
  expect(outcome).toEqual({ loopback: 200, relay: 200, elsewhere: "blocked" })
  // Refused by the policy before any request left the page.
  expect(elsewhere).toEqual([])
  await expect
    .poll(() => violations(page))
    .toEqual([{ blocked: "https://example.com/collect", directive: "connect-src" }])
})
