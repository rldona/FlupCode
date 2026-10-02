import { expect, test } from "@playwright/test"

/**
 * Screens and dialogs load on demand (UX-00), as chunks the page does not name. The service worker
 * precaches them with the shell, so one never opened before still opens without a network, as it
 * did when everything was in one bundle.
 */
test("a screen and a dialog never opened before still open offline", async ({ page, context }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
  })
  await page.goto("/")
  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.setOffline(true)
  // Offline emulation does not reach what the service worker fetches itself: refuse the assets too, so
  // only its cache can answer.
  await context.route("**/assets/**", (route) => route.abort())

  await page.goto("/routines")
  await expect(page.locator(".fc-app")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible()

  await page.goto("/?dialog=settings")
  await expect(page.getByRole("dialog", { name: "Customize" })).toBeVisible()
})
