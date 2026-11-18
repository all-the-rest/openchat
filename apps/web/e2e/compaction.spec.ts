import { expect, test, type Page } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

interface CompactionRecord {
  count: number
  failures: number
  lastReason: "auto" | "manual" | null
}

async function compactionRecord(page: Page, sessionID: string): Promise<CompactionRecord> {
  const response = await page.request.get(`/api/__fake/compactions/${sessionID}`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as CompactionRecord
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer").fill(text)
  await page.getByTestId("send").click()
  await expect(
    page.getByTestId("transcript").getByText(text, { exact: true }),
  ).toBeVisible()
}

/**
 * The E2E BFF runs with CHAT_CONTEXT_SOFT_CAP=500 and the fake reports 1 000
 * tokens per finished turn, so the second prompt crosses the cap.
 */
test("crossing the soft cap compacts once and says so", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await send(page, "hello before the cap")
  await expect(page.getByTestId("chat-status")).toHaveText("Ready")
  expect((await compactionRecord(page, sessionID)).count).toBe(0)

  await send(page, "hello after the cap")
  await expect(
    page.getByText("Context was compacted before sending your message."),
  ).toBeVisible()

  const record = await compactionRecord(page, sessionID)
  expect(record).toMatchObject({ count: 1, failures: 0, lastReason: "auto" })
  expect(external).toEqual([])
})

test("Compact now compacts and renders the collapsed section", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("chat-menu").click()
  await page.getByTestId("compact-now").click()

  const ended = page.getByTestId("compaction-ended")
  await expect(ended).toBeVisible()
  await expect(ended).toContainText("Compaction finished")
  await expect(page.getByTestId("compaction-summary")).toContainText(
    "Earlier conversation summarised by the fake backend.",
  )
  expect((await compactionRecord(page, sessionID)).lastReason).toBe("manual")
  expect(external).toEqual([])
})

test("a failed compaction shows its reason and retries", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  const failure = await page.request.post("/api/__fake/compaction-failure", {
    data: { sessionID, times: 1 },
  })
  expect(failure.ok()).toBe(true)

  await page.getByTestId("chat-menu").click()
  await page.getByTestId("compact-now").click()

  await expect(page.getByTestId("compaction-failed")).toBeVisible()
  await expect(page.getByTestId("compaction-reason")).toContainText(
    "The fake summariser failed.",
  )

  await page.getByTestId("compaction-retry").click()
  await expect(page.getByTestId("compaction-ended")).toBeVisible()
  await expect(page.getByTestId("compaction-failed")).toHaveCount(0)
  expect(await compactionRecord(page, sessionID)).toMatchObject({ count: 2, failures: 1 })
  expect(external).toEqual([])
})
