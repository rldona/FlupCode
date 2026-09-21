import { chromium, expect, test } from "@playwright/test"

/**
 * Local Network Access (H-45) only applies to a website reaching a device: the preview server is on
 * localhost, where loopback-to-loopback is not gated and nothing would show. A hostname mapped to
 * 127.0.0.1 gives the app a public origin while the engine stays on loopback, which is the shape of
 * the hosted app. The permission is real — Chromium answers the query and the granted context really
 * is granted — and the engine is mocked, which is the only way to be "listening" in a test.
 */
const WEBSITE = "http://app.flupcode.test:4173/"

const launch = async (permissions?: string[]) => {
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP app.flupcode.test 127.0.0.1"],
  })
  const context = await browser.newContext(permissions ? { permissions } : {})
  return { browser, page: await context.newPage() }
}

const boot = async (page: import("@playwright/test").Page, health: () => "blocked" | "healthy", counted: () => void) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/global/health") {
      // The page's own health check cannot tell "blocked" from "not there": the `no-cors` probe is
      // what says the engine is listening, so it answers while the ordinary calls wait. The probe is
      // the request a no-cors fetch makes, and that one carries no `origin` header.
      if (!route.request().headers()["origin"]) return route.fulfill({ status: 200, body: "" })
      if (health() === "blocked") return route.abort()
      counted()
      return route.fulfill({ json: { healthy: true, version: "e2e" } })
    }
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(WEBSITE)
}

test("a blocked page asks for local network access and connects once it is allowed", async () => {
  const { browser, page } = await launch()
  let granted = false
  let answered = 0
  await boot(page, () => (granted ? "healthy" : "blocked"), () => answered++)

  const banner = page.locator(".fc-offline-banner")
  await expect(banner).toContainText(/permission to reach the engine|permiso para llegar al engine/)
  const allow = banner.getByRole("button", { name: /Allow access|Permitir acceso/ })
  await expect(allow).toBeVisible()

  // The user answers the prompt: the annotated request the click sends is let through, and the app
  // treats that answer as the permission before asking the browser for its state.
  granted = true
  await allow.click()
  // The ask itself, and then the health check it retries.
  await expect.poll(() => answered).toBeGreaterThanOrEqual(2)
  await expect(banner).toHaveCount(0)
  await browser.close()
})

test("a browser that already granted it connects without being asked", async () => {
  const { browser, page } = await launch(["local-network-access"])
  let answered = 0
  await boot(page, () => "healthy", () => answered++)

  await expect(page.locator(".fc-offline-banner")).toHaveCount(0)
  expect(answered).toBeGreaterThan(0)
  await browser.close()
})

test("a page still blocked with the permission granted is told what the engine has to allow", async () => {
  const { browser, page } = await launch(["local-network-access"])
  await boot(page, () => "blocked", () => {})

  // The permission is not what is missing, so asking for it again would answer nothing: what the
  // engine needs is this origin on its allowed list.
  const banner = page.locator(".fc-offline-banner")
  await expect(banner).toContainText("--cors http://app.flupcode.test:4173")
  await expect(banner.getByRole("button", { name: /Allow access|Permitir acceso/ })).toHaveCount(0)
  await browser.close()
})
