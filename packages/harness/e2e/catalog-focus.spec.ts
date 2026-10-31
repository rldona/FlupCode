import { expect, test } from "@playwright/test"

const now = Date.now()

const model = (name: string) => ({
  id: "e2e-model",
  modelID: "e2e-model",
  providerID: "e2e",
  name,
  variants: [],
  time: { released: now },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 8_000 },
})

// A provider can rename a model while FlupCode stays open for days. Coming back to the window rereads
// the catalog, but not on every focus: at most once every few minutes.
test("coming back to the window rereads the model catalog, at most every few minutes", async ({ page }) => {
  const reads: string[] = []
  await page.clock.install()
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model") {
      reads.push("model")
      return route.fulfill({ json: { data: [model("E2E Model")] } })
    }
    if (url.pathname === "/api/provider") {
      reads.push("provider")
      return route.fulfill({ json: { data: [] } })
    }
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect.poll(() => reads.filter((read) => read === "model").length).toBeGreaterThan(0)
  await expect.poll(() => reads.filter((read) => read === "provider").length).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  reads.length = 0

  // Switching windows right after opening the app asks nothing.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.waitForTimeout(500)
  expect(reads).toEqual([])

  // Some minutes later, it asks for both catalogs again.
  await page.clock.fastForward("05:01")
  reads.length = 0
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => reads.includes("model")).toBe(true)
  await expect.poll(() => reads.includes("provider")).toBe(true)

  // And a second focus straight after does not ask again.
  await page.waitForTimeout(500)
  reads.length = 0
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.waitForTimeout(500)
  expect(reads).toEqual([])
})
