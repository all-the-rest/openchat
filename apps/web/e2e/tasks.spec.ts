import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

/**
 * Offline task lifecycle against the fake backend. Each run owns a fresh chat,
 * so its schedule cannot collide with the other parallel workers' rows even
 * though they share one BFF process.
 */
test("create, pause, reload and delete a schedule", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("nav-tasks").click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible()
  await expect(page.getByRole("note")).toContainText(
    "Scheduled tasks run on the server even when the browser is closed.",
  )

  const form = page.getByTestId("tasks-create-form")
  await form.getByTestId("tasks-create-session").selectOption(sessionID)
  await form.getByTestId("tasks-create-prompt").fill("Summarise the notes")
  await form.getByTestId("tasks-create-submit").click()
  await expect(page.getByTestId("tasks-create-notice")).toHaveText("Schedule created.")

  const row = page.locator('[data-testid="tasks-schedule"]', { hasText: "Summarise the notes" })
  await expect(row).toBeVisible()
  await expect(row.getByTestId("tasks-schedule-status")).toHaveText("Active")
  await expect(row.getByTestId("tasks-schedule-session")).toHaveAttribute("href", `/c/${sessionID}`)

  await row.getByTestId("tasks-pause").click()
  await expect(row.getByTestId("tasks-schedule-status")).toHaveText("Paused")

  // A reload re-reads the BFF store; the pause is not a client-only state.
  await page.reload()
  const reloaded = page.locator('[data-testid="tasks-schedule"]', { hasText: "Summarise the notes" })
  await expect(reloaded.getByTestId("tasks-schedule-status")).toHaveText("Paused")

  await reloaded.getByTestId("tasks-delete").click()
  await reloaded.getByTestId("tasks-delete-confirm").click()
  await expect(page.locator('[data-testid="tasks-schedule"]', { hasText: "Summarise the notes" })).toHaveCount(0)

  expect(external).toEqual([])
})
