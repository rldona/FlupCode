import { expect, test, type Locator, type Page } from "@playwright/test"

/**
 * Every dialog behaves the same from the keyboard (UX-03), in either language: the focus moves into
 * it as it opens, Tab and Shift+Tab stay inside it, it has a close button with a name, and Escape
 * closes it.
 *
 * The dialogs a link opens (`?dialog=`) are all here; the ones that need a target (a session to
 * rename, tag, delete or export, a link to follow) are opened the way a reader opens them.
 */

const now = Date.now()

const session = {
  id: "ses_modal",
  projectID: "p",
  title: "Modal session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const messages = [
  {
    id: "a",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt" },
    time: { created: now + 1, completed: now + 3 },
    content: [{ type: "text", text: "See [the docs](https://example.com/docs)." }],
  },
  { id: "u", type: "user", text: "Where are the docs?", time: { created: now } },
]

async function open(page: Page, address: string, locale: "en" | "es") {
  await page.addInitScript((locale) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.locale", JSON.stringify(locale))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_modal"))
  }, locale)
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_modal/message")
      return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question|form)$/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(address)
}

/** The dialog on top: the last one in the page that is not a closing stand-in. */
function topDialog(page: Page) {
  return page.locator('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]').last()
}

async function holdsFocus(dialog: Locator) {
  return dialog.evaluate((node) => node.contains(document.activeElement))
}

/**
 * The four things every dialog does, checked on the one that is open. Soft, so a failure names every
 * one of them that does not hold rather than only the first.
 */
async function behaves(page: Page, top: Locator) {
  await expect(top).toBeVisible()
  // Pinned, so the checks stay on this dialog once it closes and one underneath becomes the last.
  // A copy left behind to play the exit is hidden from assistive technology, and so from this.
  await top.evaluate((node) => node.setAttribute("data-e2e-top", ""))
  const dialog = page.locator('[data-e2e-top]:not([aria-hidden="true"] [data-e2e-top])')
  const named = await dialog.evaluate(
    (node) => !!(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby")),
  )
  expect.soft(named, "the dialog has a name").toBe(true)

  // The focus moves in as it opens.
  await page.waitForTimeout(100)
  expect.soft(await holdsFocus(dialog), "the focus moves in").toBe(true)

  // Tab and Shift+Tab never leave it, from wherever the focus starts (the dialog itself, a field).
  const escapes: string[] = []
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press(key)
      if (!(await holdsFocus(dialog))) escapes.push(`${key} ${step + 1}`)
    }
  }
  expect.soft(escapes, "the focus never leaves it").toEqual([])

  // It has a close button a screen reader can name.
  await expect
    .soft(dialog.getByRole("button", { name: /^(Close|Cerrar)$/ }).first(), "a named close button")
    .toBeVisible({ timeout: 1_000 })

  // Escape closes it, whatever the button is called in this language.
  await page.keyboard.press("Escape")
  await expect(dialog, "Escape closes it").toHaveCount(0, { timeout: 2_000 })
}

const LINKED = [
  "settings",
  "about",
  "stashes",
  "remote",
  "skills",
  "best-of-n",
  "memory",
  "config",
  "config-files",
  "palette",
  "model",
  "folder",
] as const

for (const locale of ["en", "es"] as const) {
  test.describe(`in ${locale}`, () => {
    for (const dialog of LINKED) {
      test(`?dialog=${dialog} keeps the focus and closes on Escape`, async ({ page }) => {
        await open(page, `/?dialog=${dialog}`, locale)
        await behaves(page, topDialog(page))
      })
    }

    for (const [name, item] of [
      ["rename", /^(Rename|Renombrar)$/],
      ["tags", /^(Edit tags…|Editar etiquetas…)$/],
      ["delete", /^(Delete|Eliminar)$/],
    ] as const) {
      test(`the session's ${name} dialog keeps the focus and closes on Escape`, async ({ page }) => {
        await open(page, "/", locale)
        const row = page.locator(".fc-session-row", { hasText: "Modal session" }).first()
        await row.locator(".fc-session-action").click()
        await page
          .locator(".fc-menu-item")
          .filter({ has: page.locator(".fc-menu-label", { hasText: item }) })
          .click()
        await behaves(page, topDialog(page))
      })
    }

    test("the export dialog keeps the focus and closes on Escape", async ({ page }) => {
      await open(page, "/", locale)
      await page
        .getByRole("button", { name: /^(Menu|Menú)$/ })
        .first()
        .click()
      await page
        .locator(".fc-menu-item")
        .filter({ has: page.locator(".fc-menu-label", { hasText: /^(Export MD|Exportar MD)$/ }) })
        .click()
      await behaves(page, topDialog(page))
    })

    test("the external link prompt keeps the focus and closes on Escape", async ({ page }) => {
      await open(page, "/", locale)
      await page.locator(".fc-transcript a", { hasText: "the docs" }).click()
      await behaves(page, topDialog(page))
    })
    for (const [screen, button] of [
      ["workflows", /^(New workflow|Nuevo flujo)$/],
      ["routines", /New routine|Nueva rutina/],
      ["skills", /^(New skill|Nuevo skill)$/],
    ] as const) {
      test(`the ${screen} screen's editor keeps the focus and closes on Escape`, async ({ page }) => {
        await open(page, `/${screen}`, locale)
        await page.getByRole("button", { name: button }).first().click()
        await behaves(page, topDialog(page))
      })
    }

    // A dialog opened from Settings sits over it: Escape closes that one and leaves Settings open.
    for (const [section, button] of [
      ["agents", /^(New agent|Nuevo agente)$/],
      ["commands", /^(New command|Nuevo comando)$/],
      ["mcp", /^(Add server|Añadir servidor)$/],
      ["providers", /^(Add provider|Añadir proveedor)$/],
    ] as const) {
      test(`Settings' ${section} editor keeps the focus and closes on Escape, over Settings`, async ({ page }) => {
        await open(page, `/?dialog=settings&section=${section}`, locale)
        await page.getByRole("button", { name: button }).first().click()
        await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(2)
        await behaves(page, topDialog(page))
        await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1)
      })
    }
  })
}

test("a closed dialog plays its exit on a copy that leaves when the motion ends", async ({ page }) => {
  await open(page, "/?dialog=about", "en")
  await expect(topDialog(page)).toBeVisible()
  await page.keyboard.press("Escape")
  // The dialog itself is gone at once: the copy is hidden from assistive technology and the pointer.
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const copy = page.locator('[data-modal="closing"]')
  await expect(copy).toHaveCount(1)
  await expect(copy).toHaveAttribute("aria-hidden", "true")
  await expect(copy).toHaveCount(0)
})

test("under reduced motion nothing moves: no exit copy, and the tokens are zero", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open(page, "/?dialog=about", "en")
  const dialog = topDialog(page)
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((node) => getComputedStyle(node).animationDuration)).toBe("0s")
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-modal="closing"]')).toHaveCount(0)
})

test("a context menu grows out of the point it opened from", async ({ page }) => {
  await open(page, "/", "en")
  const row = page.locator(".fc-session-row", { hasText: "Modal session" }).first()
  const box = (await row.boundingBox())!
  await row.click({ button: "right", position: { x: 20, y: box.height / 2 } })
  const menu = page.locator(".fc-menu")
  await expect(menu).toBeVisible()
  // Where it was placed (its layout box, not the one its entrance is scaling) plus its origin.
  const point = await menu.evaluate((node) => {
    const [x, y] = getComputedStyle(node).transformOrigin.split(" ").map(parseFloat)
    return { x: node.offsetLeft + x!, y: node.offsetTop + y! }
  })
  expect(Math.abs(point.x - (box.x + 20))).toBeLessThan(2)
  expect(Math.abs(point.y - (box.y + box.height / 2))).toBeLessThan(2)
})
