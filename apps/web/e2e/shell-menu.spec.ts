import { expect, test } from "@playwright/test"
import { guardExternalRequests, login } from "./helpers"

/**
 * Browser coverage of the app bar overflow menu (spec 02, spec 13). Below
 * 1024 px the Chat | Code switch lives here instead of the bar, together with
 * the navigation entries the drawer would otherwise be the only home for.
 *
 * The suite runs one phone viewport; the bar's 320 px budget gets its own test
 * because that is the narrowest width the design promises to keep on one row.
 */
test.use({ viewport: { width: 390, height: 844 } })

test("the menu carries the surface switch and the navigation entries", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  // The inline switch is gone below `lg`; the bar has the drawer toggle, the
  // name and this trigger.
  await expect(page.getByTestId("surface-switch")).toHaveCount(0)
  const trigger = page.getByTestId("app-bar-menu")
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")

  await trigger.click()
  const panel = page.getByTestId("app-bar-menu-panel")
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute("role", "menu")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")

  await expect(panel.getByTestId("surface-switch")).toBeVisible()
  await expect(panel.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByRole("menuitem", { name: "Search" })).toBeVisible()
  await expect(panel.getByRole("menuitem", { name: "Apps" })).toBeVisible()
  await expect(panel.getByRole("menuitem", { name: "New chat" })).toBeVisible()
  // The session list stays in the drawer.
  await expect(panel.getByTestId("session-item")).toHaveCount(0)

  // Escape closes it and hands focus back to the trigger.
  await page.keyboard.press("Escape")
  await expect(panel).toHaveCount(0)
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(trigger).toBeFocused()

  expect(external).toEqual([])
})

test("the menu reaches /apps and switches the surface, closing itself", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)

  // Apps: a real navigation, so the menu is gone afterwards and the bar stays.
  await page.getByTestId("app-bar-menu").click()
  await page.getByTestId("app-bar-menu-panel").getByRole("menuitem", { name: "Apps" }).click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible()
  await expect(page.getByTestId("app-bar-menu-panel")).toHaveCount(0)

  // Code: the switch persists and navigates; the chat app bar gives way to the
  // Code bar, so the menu cannot stay open.
  await page.goto("/")
  await page.getByTestId("app-bar-menu").click()
  await page.getByTestId("surface-code").click()
  await expect(page).toHaveURL(/\/code$/)
  await expect(page.getByTestId("app-bar-menu-panel")).toHaveCount(0)
  await expect(page.getByTestId("code-bar")).toBeVisible()

  // Back through the Code bar's own switch: chat returns with Chat pressed.
  await page.getByTestId("surface-chat").click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByTestId("app-bar-menu").click()
  await expect(page.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")

  expect(external).toEqual([])
})

test("the bar stays on one row at 320 px with the menu open", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)
  await page.setViewportSize({ width: 320, height: 640 })

  const trigger = page.getByTestId("app-bar-menu")
  await expect(trigger).toBeVisible()
  await expect(page.getByTestId("sidebar-toggle")).toBeVisible()

  const noHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )
  expect(noHorizontalScroll).toBe(true)

  await trigger.click()
  const panel = page.getByTestId("app-bar-menu-panel")
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(320)

  expect(external).toEqual([])
})
