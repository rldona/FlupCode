import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
  })
})

test("loads the harness shell", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/FlupCode/)
  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
  await expect(page.getByText("FlupCode").first()).toBeVisible()
})

test("opens the command palette", async ({ page }) => {
  test.skip(!!process.env.CI, "requires a running OpenCode server")
  await page.goto("/")
  await page.getByRole("button", { name: /Command palette/i }).click()
  await expect(page.getByPlaceholder(/Search commands/i)).toBeVisible()
  await page.keyboard.press("Escape")
})
