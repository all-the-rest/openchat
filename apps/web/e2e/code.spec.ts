import { expect, test, type Locator, type Page } from "@playwright/test"
import { CODE_STUB_ORIGIN } from "./code-stub"
import { guardExternalRequests, login } from "./helpers"

/**
 * Browser-level coverage of the Code surface against `e2e/code-stub.ts`. The
 * stub is the Code host: it redeems the tickets the real BFF mints, so these
 * tests prove the switch, the deep link, the embedding states and the
 * credential boundary end to end without a real OpenCode.
 */
const FRAME = '[data-testid="code-frame"]'

function frame(page: Page): Locator {
  return page.frameLocator(FRAME).getByTestId("code-stub")
}

/**
 * The BFF caps ticket minting at 20 per client address per minute, and every
 * Code page load mints two tickets twice: React StrictMode double-invokes the
 * mint effect in the dev server this suite runs against, so one load is four
 * mints. Four tests in parallel would share one loopback address and trip the
 * real cap, so each test presents its own forwarded client address — the same
 * isolation two separate users get in production. The E2E BFF runs with
 * `TRUST_PROXY=1` for this reason only; the header is never trusted elsewhere.
 */
async function asSeparateClient(page: Page, address: string): Promise<void> {
  await page.route("**/api/code/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  )
}

/** The switch is the app bar's Code button; it only renders when configured. */
async function openCode(page: Page): Promise<void> {
  await expect(page.getByTestId("surface-switch")).toBeVisible()
  await page.getByTestId("surface-code").click()
  await expect(page).toHaveURL(/\/code$/)
}

test("the switch opens Code in a single bar and returns to chat", async ({ page }) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.11")

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  // Chat owns the app bar and the sidebar.
  await expect(page.getByTestId("app-bar")).toBeVisible()
  await openCode(page)

  // Code owns its own slim bar: exactly one switch, no app bar, no sidebar.
  await expect(page.getByTestId("code-bar")).toBeVisible()
  await expect(page.getByTestId("surface-switch")).toHaveCount(1)
  await expect(page.getByTestId("app-bar")).toHaveCount(0)
  await expect(page.getByTestId("app-drawer")).toHaveCount(0)
  await expect(page.getByTestId("surface-code")).toHaveAttribute("aria-pressed", "true")

  // The frame is the stub host, titled by the app's translated label.
  await expect(page.locator(FRAME)).toHaveAttribute("title", "OpenCode workspace")
  await expect(frame(page)).toBeVisible()

  // Chat is back: the bar and the sidebar return, still with one switch.
  await page.getByTestId("surface-chat").click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId("app-bar")).toBeVisible()
  await expect(page.getByTestId("app-drawer")).toBeVisible()
  await expect(page.getByTestId("surface-switch")).toHaveCount(1)
  await expect(page.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")

  expect(external).toEqual([])
})

test("a deep link reaches the Code host path and survives a reload", async ({ page }) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.12")

  await page.goto("/")
  await login(page)

  await page.goto("/code/deep/path")
  // The stub echoes the path it was asked for: the `/code` suffix reached the
  // ticket's `next` and the host's redirect.
  await expect(page.frameLocator(FRAME).getByTestId("code-path")).toHaveText("/deep/path")

  await page.reload()
  await expect(page).toHaveURL(/\/code\/deep\/path$/)
  await expect(page.frameLocator(FRAME).getByTestId("code-path")).toHaveText("/deep/path")

  expect(external).toEqual([])
})

test("a rejected ticket shows the sign-in state and foreign messages are ignored", async ({
  page,
}) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.13")

  await page.goto("/")
  await login(page)
  await openCode(page)
  await expect(frame(page)).toBeVisible()

  // The app accepts the unauthenticated state only from the frame's own origin.
  // A message posted from the app origin itself must change nothing.
  await page.evaluate(() => {
    window.postMessage({ type: "openchat:code-state", state: "unauthenticated" }, "*")
  })
  await expect(page.locator(FRAME)).toBeVisible()
  await expect(frame(page)).toBeVisible()
  await expect(page.getByTestId("code-sign-in")).toHaveCount(0)

  // `/code/signed-out` arrives as `next=/signed-out`, which the stub rejects on
  // purpose even for a valid ticket; its 401 page posts the state to the app.
  await page.goto("/code/signed-out")
  await expect(page.getByRole("heading", { name: "Sign in to open Code" })).toBeVisible()
  await expect(page.getByTestId("code-state")).toHaveText("Signed out")
  await expect(page.getByTestId("code-sign-in")).toHaveText("Sign in to Code")
  await expect(page.getByTestId("code-sign-in")).toBeEnabled()

  expect(external).toEqual([])
})

test("the upstream credential never reaches the browser", async ({ page }) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.14")
  const browserCredentials: string[] = []
  page.on("request", (request) => {
    if (!request.url().startsWith(CODE_STUB_ORIGIN)) return
    const authorization = request.headers().authorization
    if (authorization) browserCredentials.push(request.url())
  })

  await page.goto("/")
  await login(page)
  await openCode(page)
  await expect(frame(page)).toBeVisible()

  const response = await page.request.get(`${CODE_STUB_ORIGIN}/__requests`)
  expect(response.ok()).toBe(true)
  const { requests } = (await response.json()) as {
    requests: Array<{
      kind: "browser" | "upstream"
      method: string
      path: string
      authorization: { present: boolean; scheme: string | null }
    }>
  }

  // The stub performs the same server-side hop a real Code host does: one
  // loopback request carrying the injected Basic credential.
  expect(
    requests.some(
      (entry) =>
        entry.kind === "upstream" &&
        entry.authorization.present &&
        entry.authorization.scheme === "Basic",
    ),
  ).toBe(true)

  // No browser request to the Code host origin carried any authorization.
  const browserWithAuthorization = requests.filter(
    (entry) => entry.kind === "browser" && entry.authorization.present,
  )
  expect(browserWithAuthorization).toEqual([])
  expect(browserCredentials).toEqual([])
  await expect(frame(page).getByTestId("code-path")).toBeVisible()
  await expect(frame(page)).not.toContainText("Basic")

  expect(external).toEqual([])
})
