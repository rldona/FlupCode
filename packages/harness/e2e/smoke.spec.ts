import { expect, test } from "@playwright/test"

test("loads the harness shell", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/FlupCode/)

  const start = page.getByRole("button", { name: /Get started/i })
  if (await start.isVisible().catch(() => false)) await start.click()

  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
  await expect(page.getByText("FlupCode").first()).toBeVisible()
})

test("opens the command palette", async ({ page }) => {
  await page.goto("/")
  const start = page.getByRole("button", { name: /Get started/i })
  if (await start.isVisible().catch(() => false)) await start.click()

  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByPlaceholder(/Search commands/i)).toBeVisible()
  await page.keyboard.press("Escape")
})
