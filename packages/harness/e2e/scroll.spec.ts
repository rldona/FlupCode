import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_long",
  projectID: "p",
  title: "Long session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// Tall prompts make the lazy rendering (content-visibility) kick in, which is what used to move the
// reader when older messages were prepended above the loaded window.
const messages = Array.from({ length: 260 }, (_, index) => ({
  id: `msg_${String(index).padStart(3, "0")}`,
  type: "user",
  text: `Message ${index}\n${"line\n".repeat(40)}`,
  time: { created: now + index },
}))

test("loading earlier messages keeps the reader in place", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_long/message") return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const container = page.locator(".fc-transcript")
  await expect(container).toBeVisible()
  await expect(page.getByText("Message 259", { exact: false })).toBeVisible()

  // The message at the top of the viewport, and where it sits, is what must not move.
  const snapshot = () =>
    container.evaluate((element) => {
      const top = element.getBoundingClientRect().top
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (candidate) => candidate.getBoundingClientRect().top >= top,
      )
      return {
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: Math.round(element.scrollHeight),
        id: anchor?.dataset.messageId ?? null,
        offset: anchor ? Math.round(anchor.getBoundingClientRect().top - top) : null,
      }
    })

  // Resolves once the transcript's height has stopped changing.
  const settled = async () => {
    let previous = -1
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.waitForTimeout(100)
      const height = (await snapshot()).scrollHeight
      if (height === previous) return
      previous = height
    }
  }

  const button = page.getByRole("button", { name: "Load earlier messages" })
  await expect(button).toBeVisible()

  // Every earlier page lands above the reader without dragging the view to the start. The reader
  // walks up to the button at the top of the loaded window before each page.
  for (let page$ = 0; page$ < 3; page$++) {
    // With the wheel, as a reader would: the transcript tells their scroll from its own corrections
    // by their hands being on it, which a programmatic scrollTop cannot show.
    await container.hover()
    await page.mouse.wheel(0, -200_000)
    await page.waitForTimeout(200)
    const before = await snapshot()
    await button.click()
    // Markdown is parsed and highlighted off the main thread, so the prepended page keeps growing
    // after it is inserted: the anchor must hold until the layout stops moving, not just for a
    // frame or two.
    await settled()
    const after = await snapshot()
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight)
    expect(after.id).toBe(before.id)
    expect(Math.abs((after.offset ?? 0) - (before.offset ?? 0))).toBeLessThan(2)
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop)
  }
})

test("a jump to an earlier prompt stays up", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_long/message") return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const container = page.locator(".fc-transcript")
  await expect(page.getByText("Message 259", { exact: false })).toBeVisible()

  // Scroll up by hand to the middle, as a reader would, so following is off.
  await container.hover()
  await page.mouse.wheel(0, -12_000)
  await page.waitForTimeout(300)

  // Focusing the ticks opens the navigator (focusin), which hovering would too — but the open menu
  // covers the ticks, so the pointer could not stay on them.
  await page.locator(".fc-chapters-ticks").focus()
  const items = page.locator(".fc-chapters-item")
  await expect(items.first()).toBeVisible()
  // The first prompt, far above the loaded window: it must land at the top of the chat.
  await items.first().click()
  await page.waitForTimeout(1000)

  const box = (await container.boundingBox())!
  const target = (await container.locator('[data-chapter="msg_000"]').boundingBox())!
  expect(target.y - box.y).toBeLessThan(40)
})
