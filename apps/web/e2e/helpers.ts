import { expect, type Page } from "@playwright/test"

/** Hosts the app itself uses in the E2E run (BFF on 8787, Vite on 5173). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * Records every HTTP(S) request to a non-local host. The caller asserts the
 * returned array is empty at the end of its test.
 */
export function guardExternalRequests(page: Page): string[] {
  const external: string[] = []
  page.on("request", (request) => {
    const raw = request.url()
    if (!/^https?:/i.test(raw)) return
    const host = new URL(raw).hostname
    if (!LOCAL_HOSTS.has(host)) external.push(raw)
  })
  return external
}

/** Signs in with the fixed fake-backend password and waits for the landing page. */
export async function login(page: Page): Promise<void> {
  await page.getByTestId("login-password").fill("test-password")
  await page.getByTestId("login-submit").click()
  await expect(page).toHaveURL(/\/$/)
}

/**
 * Creates a chat and waits for it to become the active route. The shared fake
 * backend already holds chats from parallel tests, so the active sidebar entry
 * (`aria-current="page"`) identifies the one this test just created.
 */
export async function startChat(page: Page): Promise<string> {
  await page.getByTestId("new-chat").click()
  await expect(page).toHaveURL(/\/c\/[^/]+$/)

  const sessionID = new URL(page.url()).pathname.split("/").pop() ?? ""
  await expect(
    page.locator('[data-testid="session-item"][aria-current="page"]'),
  ).toHaveAttribute("href", `/c/${sessionID}`)
  return sessionID
}
