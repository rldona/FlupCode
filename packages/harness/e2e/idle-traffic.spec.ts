import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_idle",
  projectID: "p",
  title: "Idle",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// The engine's health is polled every 10s so a server that comes back is noticed. That poll writes a
// fresh value whether or not the answer changed, and everything reading it used to wake with it: the
// event streams were dropped and reopened, and sessions, messages and both blocked registries were
// refetched, on a clock, for as long as the app was open. Against an engine that no longer holds the
// open session it was a flood of 404s; against any engine it was work nobody asked for.
test("an idle app does not re-ask the engine on the health clock", async ({ page }) => {
  const calls: string[] = []
  let streams = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_idle"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    calls.push(url.pathname)
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    // An empty catalog is retried on the same poll, by design; a loaded one must not be.
    if (url.pathname === "/api/model")
      return route.fulfill({ json: { data: [{ id: "e2e-model", providerID: "e2e", name: "E2E Model" }] } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_idle/message")
      return route.fulfill({
        json: { data: [{ id: "msg_u", type: "user", text: "Say hello", time: { created: now } }], cursor: {} },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    // A healthy stream: held open, and quiet because nothing is running.
    if (url.pathname === "/api/event" || url.pathname === "/event") {
      streams++
      return new Promise(() => {})
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Say hello")).toBeVisible()
  // Let the first load settle before measuring: what is being measured is the clock, not startup.
  await page.waitForTimeout(2_000)
  const streamsAfterLoad = streams
  calls.length = 0

  // Long enough for two health polls to land.
  await page.waitForTimeout(25_000)

  // The poll itself is the only traffic an idle app owes the engine.
  const health = calls.filter((path) => path.endsWith("/health"))
  expect(health.length).toBeGreaterThan(0)
  expect(calls.filter((path) => !path.endsWith("/health"))).toEqual([])

  // And the streams it already holds are still the same ones.
  expect(streams).toBe(streamsAfterLoad)
})
