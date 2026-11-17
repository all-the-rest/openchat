import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

test("slow scenario can be stopped by the user", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)
  await startChat(page)

  const transcript = page.getByTestId("transcript")
  await page.getByTestId("composer").fill("slow: waiting")
  await page.getByTestId("send").click()

  const assistant = transcript.getByTestId("message-assistant").last()
  await expect(assistant).toContainText("Slow scenario chunk")
  await expect(page.getByTestId("stop")).toBeVisible()

  await page.getByTestId("stop").click()
  await expect(page.getByTestId("stop")).toBeHidden()
  await expect(page.getByTestId("chat-status")).toHaveText("Stopped")

  expect(external).toEqual([])
})
