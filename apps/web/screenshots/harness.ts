// Page-level helpers for the ui-review captures: login, navigation, variant
// application and the settle-then-capture sequence.
//
// Theme and locale variants are seeded through `addInitScript` (which runs
// before the app mounts on every navigation), so the first paint already shows
// the requested state and no UI has to be clicked through. Each Playwright test
// gets a fresh context, so variants cannot leak into each other; the sessions
// come from the seed file that the `seed` project wrote once for the whole run.

import { expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { LOCALE_STORAGE_KEY } from "../src/i18n"
import { THEME_STORAGE_KEY } from "../src/theme/provider"
import { captureSections } from "./capture"
import { uiReviewConfig, uiReviewPassword } from "./ui-review.config"
import type {
  UiReviewNavStep,
  UiReviewRoute,
  UiReviewState,
  UiReviewVariant,
  UiReviewViewport,
} from "./ui-review.config"

/** How long the drawer slide-in (`duration-200`) needs before the pixels hold. */
const DRAWER_TRANSITION_MS = 250
/** Long enough for the dictation clock to leave `0:00` and the meter to move. */
const DICTATION_SETTLE_MS = 1200

function resolvePath(pattern: string, params: Record<string, unknown>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    const value = params[key]
    if (value === undefined || value === null) {
      throw new Error(`Route param "${key}" was not resolved by the seed for "${pattern}"`)
    }
    return String(value)
  })
}

function resolveUrl(routePath: string, origin: string): string {
  return new URL(routePath, origin).toString()
}

/** Let the SPA + i18n settle so later clicks never race a layout shift. */
export async function waitForAppSettled(page: Page): Promise<void> {
  // No `networkidle`: the authenticated app holds an SSE connection open.
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("main").waitFor({ state: "visible" })
  await page.waitForTimeout(300)
}

/** Temporarily disable CSS smooth scrolling while screenshots are positioned. */
async function withInstantScrollBehavior(page: Page, capture: () => Promise<void>): Promise<void> {
  const override = await page.addStyleTag({
    content: "html, body, * { scroll-behavior: auto !important; }",
  })
  try {
    await capture()
  } finally {
    await override.evaluate((style) => (style as Element).remove())
  }
}

/** UI login through the real form: one password field, then a redirect to `/`. */
async function loginViaUi(page: Page, origin: string, landing: RegExp): Promise<void> {
  await page.goto(`${origin}/login`)
  await expect(page).toHaveURL(/\/login$/)
  const main = page.getByRole("main")
  await main.getByTestId("login-password").fill(uiReviewPassword)
  await main.getByTestId("login-submit").click()
  await expect(page).toHaveURL(landing)
  await waitForAppSettled(page)
}

async function applyNavStep(
  page: Page,
  step: UiReviewNavStep,
  seed: Record<string, unknown>,
  origin: string,
): Promise<void> {
  if (step.kind === "goto") {
    await page.goto(resolveUrl(resolvePath(step.path, seed), origin))
    return
  }

  const region = page.getByRole(step.scope)
  let locator = region.getByRole(
    step.role,
    step.name !== undefined ? { name: step.name, exact: true } : undefined,
  )
  if (step.within !== undefined) {
    locator = region
      .locator("article", { hasText: String(seed[step.within]) })
      .getByRole(step.role, { name: step.name, exact: true })
  }
  await locator.first().click()
  await waitForAppSettled(page)
}

/**
 * Persist theme/locale before the app boots. The keys are the app's own
 * `THEME_STORAGE_KEY` and `LOCALE_STORAGE_KEY`; `Theme` is `dark | light`,
 * `Locale` is `en | de`. Storage may be unavailable on the initial empty
 * document, hence the guard: the script runs again on the real navigation.
 */
async function applyVariantSettings(page: Page, variant?: UiReviewVariant): Promise<void> {
  if (!variant?.theme && !variant?.locale) return
  await page.addInitScript(
    ({ keys, values }) => {
      try {
        if (values.theme) window.localStorage.setItem(keys.theme, values.theme)
        if (values.locale) window.localStorage.setItem(keys.locale, values.locale)
      } catch {
        // Storage can be unavailable before an origin exists.
      }
    },
    {
      keys: { theme: THEME_STORAGE_KEY, locale: LOCALE_STORAGE_KEY },
      values: { theme: variant.theme ?? null, locale: variant.locale ?? null },
    },
  )
}

/** Post-load variant: open the mobile drawer, expand a tool card or start dictation. */
async function applyVariantAction(page: Page, variant?: UiReviewVariant): Promise<void> {
  if (variant?.action === "open-drawer") {
    await page.getByTestId("sidebar-toggle").click()
    const drawer = page.getByTestId("app-drawer")
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveAttribute("aria-modal", "true")
    await page.waitForTimeout(DRAWER_TRANSITION_MS)
    return
  }

  if (variant?.action === "start-dictation") {
    // The control only exists when `/api/info` advertises a configured STT
    // service, so a missing button is a real failure, not an empty state.
    await page.getByTestId("dictation").click()
    await expect(page.getByTestId("dictation-pill")).toBeVisible()
    await page.waitForTimeout(DICTATION_SETTLE_MS)
    return
  }

  if (variant?.action === "expand-tool") {
    const toggle = page.locator('[data-testid="tool-card"] button[aria-expanded]').first()
    await toggle.waitFor({ state: "visible", timeout: 30_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    const panelID = await toggle.getAttribute("aria-controls")
    if (!panelID) throw new Error("Expanded tool card toggle has no aria-controls target")
    await expect(page.locator(`[id="${panelID}"]`)).toBeVisible()
  }
}

async function settleAndCapture(
  page: Page,
  route: UiReviewRoute,
  state: UiReviewState,
  viewport: UiReviewViewport,
  variant?: UiReviewVariant,
): Promise<void> {
  await waitForAppSettled(page)
  await expect(page).toHaveTitle(route.expectedTitle)
  await expect(page.getByRole("main")).toBeVisible()
  await applyVariantAction(page, variant)
  await withInstantScrollBehavior(page, () =>
    captureSections(page, state, viewport, route, variant),
  )
}

/** Full flow for one matrix cell: seed, variant, login, nav, capture. */
export async function captureRoute(
  page: Page,
  route: UiReviewRoute,
  state: UiReviewState,
  viewport: UiReviewViewport,
  variant?: UiReviewVariant,
): Promise<void> {
  const origin = uiReviewConfig.primaryOrigin
  const seed = route.seeds?.[state] ? await route.seeds[state]() : {}

  await applyVariantSettings(page, variant)
  await page.goto(`${origin}/`)
  await waitForAppSettled(page)

  if (route.auth === "user") {
    await loginViaUi(page, origin, /\/$/)
  }

  for (const step of route.nav ?? []) {
    await applyNavStep(page, step, seed, origin)
  }

  await settleAndCapture(page, route, state, viewport, variant)
}
