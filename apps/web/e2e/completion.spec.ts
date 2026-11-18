import { expect, test } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"

const BFF = "http://localhost:8787"

test("the chosen model reaches the fake host", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  await page.getByTestId("model-select").selectOption("fake/echo")
  await page.getByTestId("composer").fill("model check")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("transcript")).toContainText("Hello from the deterministic fake backend")

  const response = await page.request.get(`${BFF}/api/__fake/prompt/${sessionID}`)
  expect(response.ok()).toBeTruthy()
  expect(await response.json()).toMatchObject({ text: "model check", model: "fake/echo" })

  expect(external).toEqual([])
})

test("an approval card blocks sending until denied and notes the denial", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  const sessionID = await startChat(page)

  const asked = await page.request.post(`${BFF}/api/__fake/permission`, {
    data: { sessionID, tool: "bash", action: "Run pnpm test" },
  })
  expect(asked.ok()).toBeTruthy()

  const card = page.getByTestId("permission-card")
  await expect(card).toBeVisible()
  await expect(card).toContainText("bash requests:")
  await expect(card).toContainText("Run pnpm test")
  await expect(page.getByTestId("composer")).toBeDisabled()
  await expect(page.getByTestId("send")).toBeDisabled()

  await page.getByTestId("permission-deny").click()

  await expect(card).toHaveCount(0)
  await expect(page.getByTestId("composer")).toBeEnabled()
  await page.getByTestId("composer").fill("after denial")
  await expect(page.getByTestId("send")).toBeEnabled()
  await expect(page.getByTestId("transcript")).toContainText(/denied/i)

  expect(external).toEqual([])
})

test("settings persist across a reload", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)

  await page.getByTestId("app-settings").click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByTestId("server-status")).toBeVisible()

  const content = page.getByTestId("app-content")
  await content.getByTestId("locale-select").selectOption("de")
  await content.getByTestId("model-select").selectOption("fake/echo")
  await page.reload()

  await expect(page.locator("html")).toHaveAttribute("lang", "de")
  await expect(page.getByTestId("model-select")).toHaveValue("fake/echo")
  expect(external).toEqual([])
})
