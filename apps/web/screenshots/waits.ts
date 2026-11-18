// Page-readiness predicates for the ui-review captures.
//
// Each route in `ui-review.config.ts` names one of these as
// `waitForContentReady`; the capture machinery calls it at every scroll
// position, so "ready" must be a visible marker that survives re-checking.
// They live here rather than in the manifest to keep the manifest to route data
// (and inside the 400-line budget).

import { expect } from "@playwright/test"
import type { Page } from "@playwright/test"

export const waitForMermaid = async (page: Page) => {
  await page.locator('[data-testid="mermaid"] svg').first().waitFor({ timeout: 30_000 })
}

export const waitForToolCards = async (page: Page) => {
  await page.locator('[data-testid="tool-card"]').first().waitFor({ timeout: 30_000 })
}

/**
 * The search page debounces 250 ms, asks the BFF and then renders; waiting for
 * the first hit covers both and fails loudly if the fixture stops matching.
 */
export const waitForSearchResults = async (page: Page) => {
  await page.locator("[data-search-result]").first().waitFor({ timeout: 30_000 })
}

/**
 * `/apps` reads `/api/apps` after mount. Both lists come from the fake's fixed
 * inventory, so waiting for every row covers the whole page; a missing row
 * fails loudly instead of capturing the loading state.
 */
export const waitForAppsInventory = async (page: Page) => {
  await expect(page.locator('[data-testid="apps-server"]')).toHaveCount(5, { timeout: 30_000 })
  await expect(page.locator('[data-testid="apps-skill"]')).toHaveCount(2, { timeout: 30_000 })
}

/**
 * The Code capture frames the stub host. Below the `lg` breakpoint the app
 * deliberately renders the desktop-orientation notice instead of a frame, so
 * the terminal state is either the stub marker inside the frame or that notice.
 * Polled by count rather than `locator.or()`: a `frameLocator` operand is not
 * resolved once the frame does not exist, and the narrow layout never has one.
 */
export const waitForCodeStub = async (page: Page) => {
  const marker = page.frameLocator('[data-testid="code-frame"]').getByTestId("code-stub")
  const narrowNotice = page.getByTestId("code-new-tab-fallback")
  await expect
    .poll(
      async () => {
        if ((await narrowNotice.count()) > 0) {
          return (await narrowNotice.first().isVisible()) ? "ready" : "waiting"
        }
        return (await marker.count()) > 0 ? "ready" : "waiting"
      },
      { timeout: 30_000 },
    )
    .toBe("ready")
}

/**
 * The app bar's overflow menu is open. The panel is the marker of the state:
 * before the click it is absent, and a closed or unmounted menu fails loudly
 * instead of capturing the plain bar.
 */
export const waitForAppBarMenu = async (page: Page) => {
  await expect(page.getByTestId("app-bar-menu-panel")).toBeVisible({ timeout: 30_000 })
}
