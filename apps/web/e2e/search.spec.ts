import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

test("search groups the fake sources and keeps web for a submitted query", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  await page.getByTestId("nav-search").click()
  await expect(page).toHaveURL(/\/search\?scope=all$/)
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible()

  const input = page.getByLabel("Search term")
  await input.fill("opencode")

  // Workspace and app sources follow the debounce; web waits for Enter, so the
  // fake provider citation must not be there yet.
  await expect(page.getByText("README.md").first()).toBeVisible()
  await expect(page.getByText("example.test")).toHaveCount(0)
  await expect(page.getByText("Web is searched when you press Enter.")).toBeVisible()
  await expect(page).toHaveURL(/\/search\?scope=all&q=opencode$/)

  await input.press("Enter")
  await expect(page.getByText("example.test").first()).toBeVisible()
  await expect(page.getByText("Web is searched when you press Enter.")).toHaveCount(0)

  // The web hit is a citation that opens in a new tab; nothing is fetched here.
  const citation = page.locator('a[data-search-result][href^="https://example.test/"]').first()
  await expect(citation).toHaveAttribute("target", "_blank")

  // Switching a source off re-queries without it and keeps the others.
  await page.getByTestId("search-source-web").click()
  await expect(page.getByText("example.test")).toHaveCount(0)
  await expect(page.getByText("README.md").first()).toBeVisible()

  // Clearing the field returns to the prompt and removes the query from the URL.
  await input.fill("")
  await expect(page.getByText("Type a search term.")).toBeVisible()
  await expect(page).toHaveURL(/\/search\?scope=all$/)

  expect(external).toEqual([])
})

test("a chat hit jumps to the message and marks it", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("composer").fill("opencode deep link")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("message-assistant").last()).toBeVisible()
  await expect(page.getByTestId("stop")).toBeHidden()

  await page.getByTestId("nav-search").click()
  await page.getByLabel("Search term").fill("opencode deep link")

  // The fake emits message-level chat hits; the user message is the first one.
  const hit = page.locator('[data-search-result][href^="/c/"]').first()
  await expect(hit).toBeVisible()
  await hit.click()

  await expect(page).toHaveURL(new RegExp(`/c/${sessionID}/[^/]+$`))
  await expect(page.locator('[data-highlighted="true"]')).toBeVisible()

  expect(external).toEqual([])
})
