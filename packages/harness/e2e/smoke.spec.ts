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
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message))
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE", message.text())
  })
  await page.goto("/")
  const button = page.getByRole("button", { name: /Command palette/i })
  await expect(button).toBeVisible()
  await button.click()
  await page.waitForTimeout(500)
  console.log("DIAG modal-backdrops:", await page.locator(".fc-modal-backdrop").count())
  console.log("DIAG placeholders:", await page.locator("[placeholder]").evaluateAll((els) => els.map((el) => el.getAttribute("placeholder"))))
  await expect(page.getByPlaceholder(/Search commands/i)).toBeVisible()
  await page.keyboard.press("Escape")
})
