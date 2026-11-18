import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

/** Dev-server module paths that belong to the lazy chat/renderer payload. */
function isChatCode(pathname: string): boolean {
  return (
    pathname.startsWith("/src/render/") ||
    pathname.startsWith("/src/chat/Transcript") ||
    pathname.startsWith("/src/pages/ChatPage")
  )
}

test("anonymous access requires login and lands on the empty landing page", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId("login-user")).toBeVisible()
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

test("login and landing never download chat or renderer code", async ({ page }) => {
  const requests: string[] = []
  page.on("request", (request) => requests.push(new URL(request.url()).pathname))

  await page.goto("/")
  await expect(page.getByTestId("login-user")).toBeVisible()
  await login(page)
  await expect(
    page.getByRole("heading", { name: "What do you want to work on?" }),
  ).toBeVisible()

  expect(requests.filter(isChatCode)).toEqual([])
})
