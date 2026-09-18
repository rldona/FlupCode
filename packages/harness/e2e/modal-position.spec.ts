import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_pos",
  projectID: "p",
  title: "Centred",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

/** How far the dialog's middle sits from the window's middle, in pixels. */
async function offsetFromCentre(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect()
    return Math.abs(box.left + box.width / 2 - window.innerWidth / 2)
  })
}

async function serve(page: Page) {
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/global/health") return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_pos/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
}

// A dialog belongs to the app, not to the chat column. Padding the backdrop by the sidebar and the
// side panels left both of these sitting off to one side of the screen.
test("the welcome screen sits in the middle of the window", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.sidebarWidth", JSON.stringify(360))
  })
  await serve(page)
  await page.goto("/")

  await expect(page.getByText(/Welcome to FlupCode/i)).toBeVisible()
  expect(await offsetFromCentre(page, ".fc-modal")).toBeLessThan(2)
})

test("Settings sits in the middle of the window, whatever is open around it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_pos"))
    // A wide sidebar and a side panel: the two things that used to push the dialog off centre.
    window.localStorage.setItem("flupcode.sidebarWidth", JSON.stringify(360))
    window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(["diff"]))
  })
  await serve(page)
  await page.goto("/")

  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  await expect(page.getByRole("heading", { name: /^Appearance$|^Apariencia$/ })).toBeVisible()
  expect(await offsetFromCentre(page, ".fc-modal")).toBeLessThan(2)
})
