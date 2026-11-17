import { expect, test } from "@playwright/test"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

test("login, rich rendering, stop, locale and theme", async ({ page }) => {
  const external: string[] = []
  page.on("request", (request) => {
    const raw = request.url()
    if (!/^https?:/i.test(raw)) return
    const host = new URL(raw).hostname
    if (!LOCAL_HOSTS.has(host)) external.push(raw)
  })

  // Unauthenticated access lands on the login form.
  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)

  await page.getByTestId("login-password").fill("test-password")
  await page.getByTestId("login-submit").click()
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole("heading", { name: "What do you want to work on?" }),
  ).toBeVisible()

  // New chat from the sidebar.
  await page.getByTestId("new-chat").click()
  await expect(page).toHaveURL(/\/c\/[^/]+$/)
  await expect(page.getByTestId("session-item").first()).toBeVisible()

  // Rich scenario: table, math, code and mermaid.
  await page.getByTestId("composer").fill("rich: show the rendering")
  await page.getByTestId("send").click()

  const assistant = page.getByTestId("message-assistant").last()
  await expect(assistant.getByRole("cell").first()).toBeVisible()
  await expect(assistant.locator(".katex").first()).toBeVisible()
  await expect(assistant.getByText("ts", { exact: true })).toBeVisible()
  await expect(assistant.getByTestId("mermaid").locator("svg").first()).toBeVisible()

  // Slow scenario, stopped by the user.
  await page.getByTestId("composer").fill("slow: waiting")
  await page.getByTestId("send").click()
  await expect(page.getByTestId("message-assistant").last()).toContainText("Slow scenario chunk")
  await expect(page.getByTestId("stop")).toBeVisible()
  await page.getByTestId("stop").click()
  await expect(page.getByTestId("stop")).toBeHidden()
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible()

  // Locale switch updates copy and the document language.
  await page.getByTestId("locale-select").selectOption("de")
  await expect(page.locator("html")).toHaveAttribute("lang", "de")
  await expect(page.getByRole("heading", { name: "Unterhaltungen" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Chat-Verlauf" })).toBeAttached()

  // Theme switch toggles the daisyUI data-theme.
  const html = page.locator("html")
  const before = await html.getAttribute("data-theme")
  await page.getByTestId("theme-toggle").click()
  await expect(html).toHaveAttribute(
    "data-theme",
    before === "openchat" ? "openchat-light" : "openchat",
  )

  expect(external).toEqual([])
})
