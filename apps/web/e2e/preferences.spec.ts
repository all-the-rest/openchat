import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

const THEME_NAMES = { dark: "openchat", light: "openchat-light" } as const
const OTHER_THEME = { dark: "light", light: "dark" } as const

// Pin the OS preference so the initial theme is deterministic; the toggle then
// has exactly one correct target.
test.use({ colorScheme: "light" })

test("locale and theme preferences switch the document", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)
  await startChat(page)

  // Locale switch updates copy and the document language.
  await page.getByTestId("locale-select").selectOption("de")
  await expect(page.locator("html")).toHaveAttribute("lang", "de")
  await expect(page.getByRole("heading", { name: "Unterhaltungen" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Chat-Verlauf" })).toBeAttached()

  // Theme switch toggles the daisyUI data-theme and persists the choice.
  const html = page.locator("html")
  await expect(html).toHaveAttribute("data-theme", /^openchat(-light)?$/)
  await expect(html).toHaveAttribute("data-theme", THEME_NAMES.light)

  await page.getByTestId("theme-toggle").click()
  await expect(html).toHaveAttribute("data-theme", THEME_NAMES[OTHER_THEME.light])
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe("dark")
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("openchat.theme")))
    .toBe("dark")

  await page.getByTestId("theme-toggle").click()
  await expect(html).toHaveAttribute("data-theme", THEME_NAMES[OTHER_THEME.dark])
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe("light")
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("openchat.theme")))
    .toBe("light")

  expect(external).toEqual([])
})
