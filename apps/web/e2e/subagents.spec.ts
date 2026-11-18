import { expect, test } from "@playwright/test"
import { guardExternalRequests, login } from "./helpers"

test("groups a subagent under its parent and opens it with a back link", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  // The fake backend seeds one deterministic parent/child pair.
  const toggle = page.locator(
    '[data-testid="session-children-toggle"][data-session-id="ses_subagent_parent"]',
  )
  const child = page.locator(
    '[data-testid="session-child"][data-session-id="ses_subagent_child"]',
  )

  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toHaveText("1")
  await expect(child).toBeHidden()
  // A child is rendered in the nested list only, never as a second top-level row.
  await expect(
    page.locator('[data-testid="session-item"][data-session-id="ses_subagent_child"]'),
  ).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(child).toBeVisible()
  await expect(child).toContainText("in Quarterly report review")

  await child.click()
  await expect(page).toHaveURL(/\/c\/ses_subagent_child$/)
  await expect(
    page.getByRole("heading", { level: 1, name: "Agent: check the figures" }),
  ).toBeVisible()

  const back = page.getByTestId("parent-link")
  await expect(back).toHaveAttribute("href", "/c/ses_subagent_parent")
  await expect(back).toContainText("Quarterly report review")
  await back.click()
  await expect(page).toHaveURL(/\/c\/ses_subagent_parent$/)
  await expect(
    page.getByRole("heading", { level: 1, name: "Quarterly report review" }),
  ).toBeVisible()

  expect(external).toEqual([])
})
