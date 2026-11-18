import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"
import {
  E2E_HTML_BYTES,
  E2E_PDF_BYTES,
  E2E_PDF_NAME,
  E2E_PNG_BYTES,
  E2E_PNG_NAME,
  E2E_ZIP_BYTES,
  E2E_ZIP_NAME,
  expectedReference,
} from "./upload-fixture"

test("picker upload, prompt reference and byte-exact download", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("attach-button").click()
  await page.getByTestId("attachment-input").setInputFiles({
    name: E2E_PDF_NAME,
    mimeType: "application/pdf",
    buffer: E2E_PDF_BYTES,
  })
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready")

  await page.getByTestId("composer").fill("Summarize this")
  await page.getByTestId("send").click()

  const userMessage = page.getByTestId("message-user").last()
  await expect(userMessage).toBeVisible()
  await expect
    .poll(async () => (await userMessage.textContent()) ?? "")
    .toContain(expectedReference(sessionID))

  const row = page.getByTestId("chat-file").filter({ hasText: E2E_PDF_NAME })
  await expect(row).toBeVisible()
  const downloadPromise = page.waitForEvent("download")
  await row.getByRole("link", { name: `Download ${E2E_PDF_NAME}` }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  expect(await readFile(path as string)).toEqual(E2E_PDF_BYTES)

  expect(external).toEqual([])
})

test("a ZIP upload shows as a generic archive and downloads byte-exact", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("attach-button").click()
  await page.getByTestId("attachment-input").setInputFiles({
    name: E2E_ZIP_NAME,
    mimeType: "application/zip",
    buffer: E2E_ZIP_BYTES,
  })
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready")

  await page.getByTestId("composer").fill("What is in this archive?")
  await page.getByTestId("send").click()

  const userMessage = page.getByTestId("message-user").last()
  await expect
    .poll(async () => (await userMessage.textContent()) ?? "")
    .toContain(expectedReference(sessionID, E2E_ZIP_NAME))

  const row = page.getByTestId("chat-file").filter({ hasText: E2E_ZIP_NAME })
  await expect(row).toBeVisible()
  await expect(row.getByTestId("chat-file-archive")).toHaveText("Archive")
  await expect(row.locator("iframe, img")).toHaveCount(0)

  const downloadPromise = page.waitForEvent("download")
  await row.getByRole("link", { name: `Download ${E2E_ZIP_NAME}` }).click()
  const path = await (await downloadPromise).path()
  expect(path).not.toBeNull()
  expect(await readFile(path as string)).toEqual(E2E_ZIP_BYTES)

  expect(external).toEqual([])
})

test("dropping a file on the composer uploads it", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await startChat(page)

  const zone = page.getByTestId("composer-dropzone")
  await expect(zone).toBeVisible()
  await page.evaluate((bytes: number[]) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array(bytes)], "dropped.pdf", { type: "application/pdf" }),
    )
    const event = new Event("drop", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "dataTransfer", { value: transfer })
    document.querySelector('[data-testid="composer-dropzone"]')?.dispatchEvent(event)
  }, Array.from(E2E_PDF_BYTES))

  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready")
  await expect(page.getByTestId("attachment-name")).toHaveText("dropped.pdf")
  expect(external).toEqual([])
})

test("pasting a file item from the clipboard uploads it", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await startChat(page)

  const field = page.getByTestId("composer")
  await expect(field).toBeVisible()
  await page.evaluate((bytes: number[]) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
    )
    const event = new Event("paste", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "clipboardData", { value: transfer })
    document.querySelector('[data-testid="composer"]')?.dispatchEvent(event)
  }, Array.from(E2E_PNG_BYTES))

  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready")
  await expect(page.getByTestId("attachment-name")).toHaveText(E2E_PNG_NAME)
  expect(external).toEqual([])
})

test("a rejected type stays as an error chip and can be removed", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await startChat(page)

  await page.getByTestId("attachment-input").setInputFiles({
    name: "evil.txt",
    mimeType: "text/plain",
    buffer: E2E_HTML_BYTES,
  })

  const chip = page.getByTestId("attachment-chip")
  await expect(chip).toHaveAttribute("data-status", "error")
  await expect(page.getByTestId("attachment-error")).toHaveText(
    "This file type is not allowed.",
  )
  await page.getByTestId("attachment-remove").click()
  await expect(chip).toHaveCount(0)
  expect(external).toEqual([])
})

test("send is disabled while an upload is in flight", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await startChat(page)

  await page.route(
    (url) => url.pathname.endsWith("/files") && url.searchParams.has("name"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await route.continue()
    },
  )

  await page.getByTestId("composer").fill("hello")
  await page.getByTestId("attachment-input").setInputFiles({
    name: E2E_PDF_NAME,
    mimeType: "application/pdf",
    buffer: E2E_PDF_BYTES,
  })

  const chip = page.getByTestId("attachment-chip")
  await expect(chip).toHaveAttribute("data-status", "uploading")
  await expect(page.getByTestId("send")).toBeDisabled()

  await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 15_000 })
  await expect(page.getByTestId("send")).toBeEnabled()
  expect(external).toEqual([])
})
