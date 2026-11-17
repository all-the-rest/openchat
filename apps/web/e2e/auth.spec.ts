import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

test("anonymous access requires login and lands on the empty landing page", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId("login-password")).toBeVisible()

  await login(page)
  await expect(
    page.getByRole("heading", { name: "What do you want to work on?" }),
  ).toBeVisible()

  // The landing page is shared state, so this test also creates its own chat;
  // nothing here depends on which chats the other workers already made.
  await startChat(page)

  expect(external).toEqual([])
})
