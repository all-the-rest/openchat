import { expect, test, type Page } from "@playwright/test"
import { guardExternalRequests, login } from "./helpers"

/**
 * Browser-level coverage of `/apps` against the fake backend's one inventory:
 * `filesystem` connected, `github` needs_auth, `postgres` failed, `notes`
 * disabled, `linear` pending, plus the `review` (autoinvoke) and `release`
 * skills.
 *
 * The fake's inventory is process-wide and Playwright runs four workers, so the
 * two tests that look at the *pristine* inventory run in `describe.serial`:
 * the read-only walk comes first, the mutating connect/disconnect second. No
 * other test touches a server's status, so they cannot upset that pair. Tests
 * three and four never change the host and stay parallel.
 *
 * Every test presents its own forwarded client address: the BFF throttles
 * connect/disconnect at 10 per address per minute, and without it the parallel
 * workers would share one loopback budget — the same isolation two separate
 * users get in production. The E2E BFF runs with `TRUST_PROXY=1` for this
 * reason only (see `e2e/code.spec.ts`).
 */
async function asSeparateClient(page: Page, address: string): Promise<void> {
  await page.route("**/api/apps/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  )
}

/** One server row, identified by its display title. */
function serverRow(page: Page, title: string) {
  return page.locator('[data-testid="apps-server"]', { hasText: title })
}

function statusOf(page: Page, title: string) {
  return serverRow(page, title).getByTestId("apps-server-status")
}

test.describe.serial("the fake inventory and its actions", () => {
  test("the sidebar entry opens the surface with every server and the skills", async ({ page }) => {
    const external = guardExternalRequests(page)
    await asSeparateClient(page, "203.0.113.31")

    await page.goto("/")
    await expect(page).toHaveURL(/\/login$/)
    await login(page)

    await page.getByTestId("nav-apps").click()
    await expect(page).toHaveURL(/\/apps$/)
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible()

    const servers = page.getByRole("region", { name: "Servers" })
    await expect(servers).toBeVisible()
    // The fixture's whole inventory, one row per status.
    await expect(servers.locator('[data-testid="apps-server"]')).toHaveCount(5)

    await expect(statusOf(page, "Filesystem")).toHaveText("Connected")
    await expect(statusOf(page, "GitHub")).toHaveText("Needs auth")
    await expect(statusOf(page, "Postgres")).toHaveText("Failed")
    await expect(statusOf(page, "Notes")).toHaveText("Disabled")
    await expect(statusOf(page, "Linear")).toHaveText("Pending")

    // The host's bounded error text is what a failed row shows.
    await expect(serverRow(page, "GitHub")).toContainText(
      "The OAuth token is missing or expired.",
    )
    await expect(serverRow(page, "Postgres")).toContainText("Connection refused after 3 attempts.")
    await expect(page.getByRole("button", { name: "Connect Postgres" })).toBeVisible()

    // `disabled` is host configuration: no action, and the note says so.
    const notes = serverRow(page, "Notes")
    await expect(notes.getByRole("button")).toHaveCount(0)
    await expect(notes).toContainText("Disabled in the host configuration.")

    // Skills carry the Auto badge and nothing to connect.
    const skills = page.getByRole("region", { name: "Skills" })
    await expect(skills).toBeVisible()
    await expect(skills.getByTestId("apps-skill")).toHaveCount(2)
    await expect(skills.getByText("Review", { exact: true })).toBeVisible()
    await expect(skills.getByText("Release", { exact: true })).toBeVisible()
    await expect(skills.getByTestId("apps-skill-auto")).toHaveCount(1)
    await expect(skills.getByTestId("apps-skill-auto")).toHaveText("Auto")
    await expect(skills.getByRole("button")).toHaveCount(0)

    // The pinned host API cannot list tools, so there is no section for them.
    await expect(page.getByRole("region", { name: "Tools" })).toHaveCount(0)

    expect(external).toEqual([])
  })

  test("connect and disconnect follow the host's next read", async ({ page }) => {
    const external = guardExternalRequests(page)
    // Only this test mutates the shared inventory; it runs after the pristine
    // walk above and leaves `github` as `pending`, which no other test asserts.
    await asSeparateClient(page, "203.0.113.32")

    await page.goto("/")
    await login(page)
    await page.goto("/apps")

    const github = serverRow(page, "GitHub")
    await expect(github.getByTestId("apps-server-status")).toHaveText("Needs auth")
    await expect(github).toContainText("The OAuth token is missing or expired.")
    const connect = github.getByRole("button", { name: "Connect GitHub" })
    await expect(connect).toBeVisible()

    await connect.click()
    // The row shows the host's answer, not an optimistic client guess.
    await expect(github.getByTestId("apps-server-status")).toHaveText("Connected")
    await expect(github.getByRole("button", { name: "Disconnect GitHub" })).toBeVisible()
    await expect(page.getByTestId("apps-notice")).toHaveText("GitHub connected.")
    await expect(page.getByRole("alert")).toHaveCount(0)

    await github.getByRole("button", { name: "Disconnect GitHub" }).click()
    await expect(github.getByTestId("apps-server-status")).toHaveText("Pending")
    await expect(page.getByTestId("apps-notice")).toHaveText("GitHub disconnected.")
    // A disconnect never removes the row or the other servers.
    await expect(page.locator('[data-testid="apps-server"]')).toHaveCount(5)

    expect(external).toEqual([])
  })
})

test("a failing action keeps the row and never prints the upstream text", async ({ page }) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.33")

  // A string that could only come from the host: a private address and a token.
  const upstreamText = "connect failed for 10.42.7.9 with token=not-for-the-browser"
  await page.route("**/api/apps/postgres/connect", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "apps_unavailable", message: upstreamText },
      }),
    }),
  )

  await page.goto("/")
  await login(page)
  await page.goto("/apps")

  const postgres = serverRow(page, "Postgres")
  await expect(postgres.getByTestId("apps-server-status")).toHaveText("Failed")
  await postgres.getByRole("button", { name: "Connect Postgres" }).click()

  // The banner is the localised "host did not answer", keyed by the 502 code.
  const banner = page.getByRole("alert")
  await expect(banner).toBeVisible()
  await expect(banner).toHaveText(/The host did not answer\./)
  await expect(banner).not.toContainText("apps_unavailable")

  // The row survives the failure with its status and a usable action.
  await expect(postgres.getByTestId("apps-server-status")).toHaveText("Failed")
  await expect(postgres.getByRole("button", { name: "Connect Postgres" })).toBeEnabled()
  await expect(page.locator('[data-testid="apps-server"]')).toHaveCount(5)

  // The upstream message is in the intercepted response body and nowhere else.
  await expect(page.getByText(upstreamText)).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("token=not-for-the-browser")
  await expect(page.locator("body")).not.toContainText("10.42.7.9")

  expect(external).toEqual([])
})

test("a deep link lands on the page inside the app shell", async ({ page }) => {
  const external = guardExternalRequests(page)
  await asSeparateClient(page, "203.0.113.34")

  await page.goto("/")
  await login(page)

  // No sidebar click: the URL alone must reach the surface.
  await page.goto("/apps")
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Servers" })).toBeVisible()

  // It renders inside the shell: sidebar, app bar, and the entry marked current.
  await expect(page.getByRole("complementary")).toBeVisible()
  await expect(page.getByTestId("app-bar")).toBeVisible()
  await expect(page.getByTestId("nav-apps")).toHaveAttribute("aria-current", "page")

  expect(external).toEqual([])
})
