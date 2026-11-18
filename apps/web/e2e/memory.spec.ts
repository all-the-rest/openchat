import { expect, test, type Page } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

/** The injected memory entry of one fake session, read through the BFF. */
async function instructionIndex(page: Page, sessionID: string): Promise<string> {
  return await page.evaluate(async (id) => {
    const response = await fetch(`/api/__fake/instructions/${id}`)
    const body = (await response.json()) as Record<string, string> | null
    return body?.["memory/index"] ?? ""
  }, sessionID)
}

/**
 * Agent-managed memory end to end: the owner adds a fact, a new chat receives
 * it in the injected index, deleting it removes it from the next index. The
 * store is a real temp `MEMORY_DIR`; the host is the fake backend.
 */
test("a fact is injected into a new chat and disappears after deletion", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)

  await page.getByTestId("nav-memory").click()
  await expect(page).toHaveURL(/\/memory$/)
  await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible()

  const text = "The owner prefers tea over coffee"
  await page.getByTestId("memory-add-text").fill(text)
  await page.getByTestId("memory-add-topic").fill("preference.drink")
  await page.getByTestId("memory-add-submit").click()
  await expect(page.getByTestId("memory-fact").filter({ hasText: text })).toBeVisible()
  await expect(page.getByTestId("memory-index")).toContainText(text)

  const withFact = await startChat(page)
  expect(await instructionIndex(page, withFact)).toContain(text)

  await page.getByTestId("nav-memory").click()
  const row = page.getByTestId("memory-fact").filter({ hasText: text })
  await row.getByTestId("memory-fact-delete").click()
  await row.getByTestId("memory-delete-reason").fill("test cleanup")
  await row.getByTestId("memory-delete-submit").click()
  await expect(page.getByTestId("memory-fact").filter({ hasText: text })).toHaveCount(0)

  const afterDelete = await startChat(page)
  expect(await instructionIndex(page, afterDelete)).not.toContain(text)

  expect(external).toEqual([])
})
