import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import {
  E2E_ARTIFACT_HOST_URL,
  E2E_ARTIFACT_HTML,
  E2E_ARTIFACT_ID,
  E2E_ARTIFACT_TITLE,
} from "./artifact-fixture"
import { guardExternalRequests, login } from "./helpers"

/**
 * `/artifacts` against the real artifact host and one deterministic document
 * seeded into the store before both servers start. Nothing here writes to the
 * store, so the two tests can run in parallel with the rest of the suite.
 */
const VIEWER_URL = `/artifacts/${E2E_ARTIFACT_ID}`
const SIGNED_URL = new RegExp(
  `^${E2E_ARTIFACT_HOST_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/a/${E2E_ARTIFACT_ID}` +
    "\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$",
)

test("lists the seeded artifact, opens it sandboxed and downloads its bytes", async ({
  page,
}) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)

  await page.getByTestId("nav-artifacts").click()
  await expect(page).toHaveURL(/\/artifacts$/)
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible()
  await expect(page.getByTestId("artifact-item")).toHaveCount(1)

  await page.getByTestId("artifact-item").click()
  await expect(page).toHaveURL(new RegExp(`${VIEWER_URL}$`))

  const frame = page.getByTestId("artifact-frame")
  await expect(frame).toHaveAttribute("src", SIGNED_URL)
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts")
  await expect(frame).toHaveAttribute("title", E2E_ARTIFACT_TITLE)
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin")

  // The host serves the document from its own origin and the sandbox runs it.
  const artifact = page.frameLocator('[data-testid="artifact-frame"]')
  await expect(artifact.getByRole("heading", { name: E2E_ARTIFACT_TITLE })).toBeVisible()

  const downloadPromise = page.waitForEvent("download")
  await page.getByTestId("artifact-download").click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${E2E_ARTIFACT_TITLE}.html`)
  const path = await download.path()
  expect(path).not.toBeNull()
  await expect(readFile(path ?? "", "utf8")).resolves.toBe(E2E_ARTIFACT_HTML)

  expect(external).toEqual([])
})

test("presents the artifact, leaves with Escape and re-mints on reload", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await page.goto(VIEWER_URL)

  const frame = page.getByTestId("artifact-frame")
  await expect(frame).toHaveAttribute("src", SIGNED_URL)
  const firstSrc = await frame.getAttribute("src")

  await page.getByTestId("artifact-present").click()
  await expect(page.getByTestId("artifact-present-layer")).toBeVisible()
  await expect(page.getByTestId("artifact-present-bar")).toBeVisible()
  await expect(page.getByTestId("artifact-frame")).toBeVisible()
  await expect(page.getByTestId("artifact-exit-present")).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(page.getByTestId("artifact-present-layer")).toHaveCount(0)
  await expect(page.getByTestId("artifact-present")).toBeFocused()

  // The signature has a second resolution: wait past a second so the fresh
  // read is observably a different URL, not the same mint within one second.
  await page.waitForTimeout(1100)
  const reloaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/artifacts/${E2E_ARTIFACT_ID}` &&
      response.request().method() === "GET",
  )
  await page.getByTestId("artifact-reload").click()
  await reloaded
  await expect
    .poll(async () => page.getByTestId("artifact-frame").getAttribute("src"))
    .not.toBe(firstSrc)
  await expect(page.getByTestId("artifact-frame")).toHaveAttribute("src", SIGNED_URL)

  expect(external).toEqual([])
})
