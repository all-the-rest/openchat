import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

/** Must match the fake STT service in `fake-stt.ts`. */
const FAKE_TRANSCRIPT = "Diktat aus dem Browser."
const DRAFT = "Notiz: "

test("dictation records in Chromium and inserts the transcript without sending", async ({ page }) => {
  const external = guardExternalRequests(page)
  const transcribeRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/transcribe") {
      transcribeRequests.push(request.method())
    }
  })

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)
  await startChat(page)

  const composer = page.getByTestId("composer")
  const mic = page.getByTestId("dictation")
  const pill = page.getByTestId("dictation-pill")
  const elapsed = page.getByTestId("dictation-elapsed")

  // The button exists because `/api/info` advertises dictation (STT_URL is set).
  await expect(mic).toBeVisible()

  await composer.fill(DRAFT)
  await composer.press("End")

  // A click is a short press: capture latches hands-free until the pill stops it.
  await mic.click()
  await expect(pill).toBeVisible()
  // "0:00" is also the initial value, so wait for the clock to cross a second.
  await expect
    .poll(async () => (await elapsed.textContent()) ?? "", { timeout: 15_000 })
    .not.toBe("0:00")

  await page.getByTestId("dictation-stop").click()

  // The caret insertion is the definitive end of the busy state.
  await expect(composer).toHaveValue(`${DRAFT}${FAKE_TRANSCRIPT}`)
  await expect(page.getByTestId("dictation-busy")).toBeHidden()

  // The transcript is editable draft text: nothing was sent to the session.
  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("message-user")).toHaveCount(0)
  await expect(transcript.getByTestId("message-assistant")).toHaveCount(0)
  expect(transcribeRequests).toHaveLength(1)

  // Escape cancels a running recording: draft stays, no second request leaves.
  await mic.click()
  await expect(pill).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(pill).toBeHidden()
  await expect(composer).toHaveValue(`${DRAFT}${FAKE_TRANSCRIPT}`)
  // Cancel discards in `onstop`; give a late stop event the chance to leak.
  await page.waitForTimeout(500)
  expect(transcribeRequests).toHaveLength(1)

  expect(external).toEqual([])
})
