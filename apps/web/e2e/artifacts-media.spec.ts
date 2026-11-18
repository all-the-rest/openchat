import { ArtifactSigner } from "@openchat/contracts/artifacts/sign"
import { expect, test } from "@playwright/test"
import {
  E2E_ARTIFACT_HOST_URL,
  E2E_ARTIFACT_ID,
  E2E_ARTIFACT_SIGNING_KEY,
  E2E_IMAGE_ID,
  E2E_IMAGE_TITLE,
} from "./artifact-fixture"
import { guardExternalRequests, login } from "./helpers"

const SIGNED_IMAGE = new RegExp(
  `^${E2E_ARTIFACT_HOST_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/a/${E2E_IMAGE_ID}` +
    "\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$",
)

test("an image artifact appears as a card and opens the viewer", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await page.getByTestId("nav-artifacts").click()

  const gallery = page.getByTestId("artifact-gallery")
  await expect(gallery).toBeVisible()
  await expect(page.getByTestId("artifact-gallery-item")).toHaveCount(1)
  const thumbnail = page.getByTestId("artifact-gallery-image")
  await expect(thumbnail).toHaveAttribute("src", SIGNED_IMAGE)
  await expect(thumbnail).toHaveAttribute("loading", "lazy")
  await expect(thumbnail).toHaveAttribute("alt", E2E_IMAGE_TITLE)

  await page.getByTestId("artifact-gallery-item").click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/${E2E_IMAGE_ID}$`))
  const image = page.getByTestId("artifact-image")
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", SIGNED_IMAGE)
  await expect(page.getByTestId("artifact-card-download")).toBeVisible()
  expect(external).toEqual([])
})

test("an expired signed URL shows a stable error, not a blank frame", async ({ page }) => {
  await page.goto("/")
  await login(page)

  // The BFF normally mints a fresh signature. This interception simulates a
  // URL that expired in transit: the host answers 403 and the frame cannot be
  // read from the parent, so the viewer must use the metadata's expiry.
  const exp = Math.floor(Date.now() / 1000) - 10
  const sig = new ArtifactSigner({ key: E2E_ARTIFACT_SIGNING_KEY }).sign(E2E_ARTIFACT_ID, exp)
  const expiredURL = `${E2E_ARTIFACT_HOST_URL}/a/${E2E_ARTIFACT_ID}?exp=${exp}&sig=${sig}`
  await page.route(`**/api/artifacts/${E2E_ARTIFACT_ID}`, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.url = expiredURL
    body.expiresAt = new Date((exp - 1) * 1000).toISOString()
    await route.fulfill({ response, json: body })
  })

  await page.goto(`/artifacts/${E2E_ARTIFACT_ID}`)
  await expect(page.getByTestId("artifact-stale-retry")).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByRole("heading", { name: "This artifact link has expired" }),
  ).toBeVisible()
})
