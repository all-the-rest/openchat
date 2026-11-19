import { expect, test } from "@playwright/test"
import { guardExternalRequests, login } from "./helpers"
import { ONBOARDING_BFF_REQUEST_ORIGIN, ONBOARDING_WEB_ORIGIN } from "./onboarding-fixture"

const KEY = "first-run-api-key-123"

/**
 * The whole first-run path against a fake host that starts with no model:
 * card → key connect → catalogue refresh → pick a default → send a prompt.
 * The route's response and the fake host's record must never carry the key.
 */
test.use({ baseURL: ONBOARDING_WEB_ORIGIN })

test("a fresh host is connected, verified and used for the first prompt", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)

  const card = page.getByTestId("first-run-card")
  await expect(card).toBeVisible()
  await expect(card).toContainText("Connect a provider")
  await expect(card).toContainText("opencode auth login")
  await expect(page.getByTestId("composer")).toHaveCount(0)

  await page.getByTestId("provider-method-fake-cloud-api-key").check()
  await page.getByTestId("provider-key-input").fill(KEY)
  await page.getByTestId("provider-field-region").selectOption("us")

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/providers/fake-cloud/connect/key") &&
      response.request().method() === "POST",
  )
  await page.getByTestId("provider-connect-submit").click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = await response.text()
  expect(body).not.toContain(KEY)

  // The card disappears exactly when the catalogue yields a model.
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId("model-select")).toBeVisible()
  await expect(page.getByTestId("composer")).toBeVisible()

  const status = await page.request.get(`${ONBOARDING_BFF_REQUEST_ORIGIN}/api/providers/status`)
  // The provider catalogue is the picker catalogue: the connect step must hand
  // the UI a full ModelInfo, not a bare id, or the default picker has nothing
  // to select.
  expect(await status.json()).toEqual({
    models: [
      {
        id: "fake/echo",
        name: "Fake Echo",
        providerID: "fake",
        providerName: "Fake Provider",
        variants: ["fast", "thorough"],
        contextLimit: 128_000,
        capabilities: { tools: true, reasoning: false, image: false },
        status: "active",
        default: true,
      },
    ],
  })

  const recorded = await page.request.get(`${ONBOARDING_BFF_REQUEST_ORIGIN}/api/__fake/providers`)
  const record = await recorded.json()
  expect(record.connects).toHaveLength(1)
  expect(record.connects[0]).toMatchObject({
    providerID: "fake-cloud",
    methodID: "api-key",
    keyLength: KEY.length,
  })
  expect(JSON.stringify(record)).not.toContain(KEY)

  // Model choice is the picker from #51, not a native select: open it and take
  // the default fake row.
  await page.getByTestId("model-select").click()
  await page.getByRole("menuitem", { name: /Fake Echo: thorough/ }).click()
  await page.getByTestId("composer").fill("first run prompt")
  await page.getByTestId("send").click()

  await expect(page).toHaveURL(/\/c\/[^/]+$/)
  const sessionID = new URL(page.url()).pathname.split("/").pop() ?? ""
  await expect(page.getByTestId("transcript")).toContainText(
    "Hello from the deterministic fake backend",
  )

  const prompt = await page.request.get(`${ONBOARDING_BFF_REQUEST_ORIGIN}/api/__fake/prompt/${sessionID}`)
  expect(await prompt.json()).toMatchObject({ text: "first run prompt", model: "fake/echo" })
  expect(external).toEqual([])
})
