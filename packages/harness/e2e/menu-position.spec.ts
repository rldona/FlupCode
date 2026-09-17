import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_menu",
  projectID: "p",
  title: "Menu",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

test("a session menu near the bottom opens upwards and stays inside the window", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_menu"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_menu/message")
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const row = page.locator(".fc-session-row").first()
  await expect(row).toBeVisible()

  // Right-click near the bottom edge, which is where the row the reader wants is when the sidebar
  // has scrolled: the menu used to keep opening downwards and lose its last items off-screen.
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("no viewport")
  const anchorY = viewport.height - 20
  await row.dispatchEvent("contextmenu", { clientX: 120, clientY: anchorY })

  const menu = page.locator(".fc-menu")
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  if (!box) throw new Error("menu has no box")
  // Above the anchor, and wholly inside the window.
  expect(box.y + box.height).toBeLessThanOrEqual(anchorY + 2)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.y).toBeGreaterThanOrEqual(0)
})
