import { expect, test } from "@playwright/test"

// The hosted app is served under `script-src 'self'` (see vercel.json), which blocks inline script
// with no way for the page to opt back in. Anything the app needs before its bundle runs — the theme
// applied before the first paint, the startup guard — has to be a file, or it silently never runs
// there and each load only leaves a violation in the console.
test("the page ships no inline script, so the hosted CSP cannot block it", async ({ page }) => {
  await page.goto("/")

  const scripts = await page.evaluate(() =>
    [...document.querySelectorAll("script")].map((script) => ({
      src: script.getAttribute("src"),
      inlineChars: script.getAttribute("src") ? 0 : script.textContent?.trim().length ?? 0,
    })),
  )
  expect(scripts.length).toBeGreaterThan(0)
  expect(scripts.filter((script) => script.inlineChars > 0)).toEqual([])
})

test("the saved theme is on the page before the app mounts", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.theme", JSON.stringify("dark"))
    window.localStorage.setItem("flupcode.colorTheme", JSON.stringify("classic"))
  })
  await page.goto("/")

  // Read it off the document before anything waits for the app: the point of the file is that it has
  // already run by now.
  // The inline background this sets is the app's to own once it mounts; the class and the palette
  // it puts on the document are what survive, and only the pre-paint script writes them this early.
  const painted = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("fc-dark"),
    palette: document.documentElement.dataset.fcTheme,
  }))
  expect(painted).toEqual({ dark: true, palette: "classic" })
})
