import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

test("rich scenario renders table, math, code and mermaid", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)
  await startChat(page)

  const transcript = page.getByTestId("transcript")
  await page.getByTestId("composer").fill("rich: show the rendering")
  await page.getByTestId("send").click()

  const assistant = transcript.getByTestId("message-assistant").last()
  await expect(assistant.getByRole("cell").first()).toBeVisible()
  await expect(assistant.locator(".katex").first()).toBeVisible()
  // The language label belongs to the first code block; a plain text match
  // would turn strict-mode ambiguous as soon as a second block appears.
  await expect(assistant.locator("figcaption").first()).toContainText("ts")
  await expect(assistant.getByTestId("mermaid").locator("svg").first()).toBeVisible()

  expect(external).toEqual([])
})
