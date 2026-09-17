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

// Each palette paints its own `--fc-bg` before the first frame, so the page never flashes white.
const SAVED_PALETTES = [
  { id: "classic", mode: "dark", background: "rgb(15, 15, 15)" },
  { id: "sublime", mode: "dark", background: "rgb(33, 37, 43)" },
  // Dark-only: it stays dark even when the mode is light.
  { id: "sublime-dark", mode: "light", background: "rgb(23, 25, 30)" },
  { id: "sublime-dark", mode: "dark", background: "rgb(23, 25, 30)" },
  { id: "github", mode: "light", background: "rgb(255, 255, 255)" },
  { id: "github", mode: "dark", background: "rgb(13, 17, 23)" },
  { id: "copilot", mode: "light", background: "rgb(255, 255, 255)" },
  { id: "copilot", mode: "dark", background: "rgb(17, 17, 20)" },
]

for (const saved of SAVED_PALETTES) {
  test(`the saved ${saved.id} palette (${saved.mode}) is on the page before the app mounts`, async ({
    page,
  }) => {
    await page.addInitScript((config) => {
      window.localStorage.setItem("flupcode.theme", JSON.stringify(config.mode))
      window.localStorage.setItem("flupcode.colorTheme", JSON.stringify(config.id))
    }, saved)
    await page.goto("/")

    // Read it off the document before anything waits for the app: the point of the file is that it has
    // already run by now. The class and the palette it puts on the document survive the mount; the
    // colour is read back through the stylesheet, so the palette block has to resolve to it too.
    const painted = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("fc-dark"),
      palette: document.documentElement.dataset.fcTheme,
      background: getComputedStyle(document.documentElement).backgroundColor,
    }))
    expect(painted).toEqual({ dark: saved.mode === "dark", palette: saved.id, background: saved.background })
  })
}
