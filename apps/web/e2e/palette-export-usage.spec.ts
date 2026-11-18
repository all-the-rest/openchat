import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import type { SessionInfo } from "@openchat/contracts"
import { guardExternalRequests, login, startChat } from "./helpers"

/** The panel formats numbers for English; pin the browser locale. */
test.use({ locale: "en-US" })

test("Ctrl+K searches a chat title and opens the session", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  // A title is what the palette searches; the UI-created chat has none, so the
  // fixture creates one through the same authenticated API the app uses.
  const created = await page.request.post("/api/sessions", {
    data: { title: "Palette target chat" },
  })
  expect(created.ok()).toBe(true)
  const session = (await created.json()) as SessionInfo

  await page.keyboard.press("Control+k")
  const palette = page.getByTestId("command-palette")
  await expect(palette).toBeVisible()
  await expect(page.getByTestId("palette-input")).toBeFocused()

  await page.getByTestId("palette-input").fill("Palette target")
  const hit = page.getByTestId("palette-chat-option").filter({ hasText: "Palette target chat" })
  await expect(hit).toBeVisible()
  await expect(page.getByTestId("palette-input")).toHaveAttribute(
    "aria-activedescendant",
    /^palette-option-chat-/,
  )

  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/c/${session.id}$`))
  await expect(palette).toHaveCount(0)

  expect(external).toEqual([])
})

test("Download chat writes the slugified title and the loaded transcript", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)
  await startChat(page)

  await page.getByTestId("composer").fill("Export me")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("message-assistant").last()).toBeVisible()
  await expect(page.getByTestId("stop")).toBeHidden()

  await page.getByTestId("chat-menu").click()
  const downloadPromise = page.waitForEvent("download")
  await page.getByTestId("chat-download").click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toBe("untitled.md")
  const path = await download.path()
  expect(path).not.toBeNull()
  const content = readFileSync(path!, "utf8")
  const lines = content.split("\n")

  expect(lines[0]).toBe("# Untitled")
  expect(lines[1]).toBe("")
  expect(lines[2]).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/)
  expect(lines[4]).toBe("## You said")
  expect(content).toContain("Export me")
  expect(content).toContain("## Assistant answer")
  expect(content).toContain("Hello from the deterministic fake backend.")
  // Tool bodies never appear; this transcript has none at all.
  expect(content).not.toContain("SECRET")

  expect(external).toEqual([])
})

test("the usage panel shows the fake backend's reported numbers", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)
  await startChat(page)

  // The panel claims a window only for a model the owner chose; the host
  // default is not part of the catalogue, so pick one deliberately.
  await page.getByTestId("model-select").click()
  await page.getByRole("menuitem", { name: /Fake Echo: Default/ }).click()
  await expect(page.getByTestId("model-select")).toContainText("Fake Echo")

  await page.getByTestId("composer").fill("Usage check")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("message-assistant").last()).toBeVisible()
  await expect(page.getByTestId("stop")).toBeHidden()

  await page.getByTestId("usage-trigger").click()
  const panel = page.getByTestId("usage-panel")
  await expect(panel).toBeVisible()
  await expect(page.getByTestId("usage-input")).toHaveText("1,200")
  await expect(page.getByTestId("usage-output")).toHaveText("333")
  await expect(page.getByTestId("usage-cached")).toHaveText("500")
  await expect(page.getByTestId("usage-limit")).toHaveText("128,000")
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1")

  expect(external).toEqual([])
})
