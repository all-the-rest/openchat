import { expect, test, type Page } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"
import { HOST_STATUS_BFF_ORIGIN, HOST_STATUS_WEB_ORIGIN } from "./host-status-fixture"

/**
 * The host-outage path against an isolated fake stack (see
 * `host-status-fixture.ts` and the two extra `webServer` entries). The switch
 * below only exists in `BACKEND_MODE=fake`; a live BFF has no such route.
 *
 * Serial: both tests flip the same in-memory host, and the second one starts
 * with it already down.
 */
test.describe.configure({ mode: "serial" })
test.use({ baseURL: HOST_STATUS_WEB_ORIGIN })

async function setHostDown(page: Page, down: boolean): Promise<void> {
  const response = await page.request.post(`${HOST_STATUS_BFF_ORIGIN}/api/__fake/host`, {
    data: { down },
  })
  expect(response.ok()).toBe(true)
}

test("a dropped host shows the banner and recovers without losing the chat", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)
  await startChat(page)

  const transcript = page.getByTestId("transcript")
  await page.getByTestId("composer").fill("hello before the outage")
  await page.getByTestId("send").click()
  await expect(transcript).toContainText("Hello from the deterministic fake backend.")

  // Drop the host. The event stream closes, the banner asks /api/info, and the
  // already-rendered transcript stays exactly where it is.
  await setHostDown(page, true)
  await expect(page.getByTestId("host-unreachable")).toBeVisible()
  await expect(transcript).toContainText("Hello from the deterministic fake backend.")
  await expect(transcript).toContainText("hello before the outage")

  const composer = page.getByTestId("composer")
  await composer.fill("draft survives the tunnel")
  await expect(page.getByTestId("host-unreachable")).toContainText("OpenCode host not reachable")

  // Bring it back. The browser reconnects the event stream; the banner clears
  // on that open without a page reload, and the draft is still in the composer.
  await setHostDown(page, false)
  await expect(page.getByTestId("host-unreachable")).toHaveCount(0, { timeout: 15_000 })
  await expect(transcript).toContainText("Hello from the deterministic fake backend.")
  await expect(composer).toHaveValue("draft survives the tunnel")

  // A recovered host accepts a new prompt: Retry is not the only way forward.
  await composer.fill("after the tunnel")
  await page.getByTestId("send").click()
  await expect(transcript.getByTestId("message-user").last()).toContainText("after the tunnel")
  await expect(page.getByTestId("host-unreachable")).toHaveCount(0)

  expect(external).toEqual([])
})

test("a dead backend at first paint clears itself when the host is back", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await login(page)

  // Reload while the host is already gone: this page's first paint is the
  // dead state, not a recovery from a previously live one.
  await setHostDown(page, true)
  await page.reload()

  // The app is up; only the host is not. No reload needed now, no page-level
  // failure.
  await expect(page.getByTestId("host-unreachable")).toBeVisible()
  await expect(page.getByTestId("composer")).toBeVisible()

  await setHostDown(page, false)
  await expect(page.getByTestId("host-unreachable")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId("composer")).toBeEnabled()

  expect(external).toEqual([])
})
