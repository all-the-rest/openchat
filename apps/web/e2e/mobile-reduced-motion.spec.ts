import { expect, test } from "@playwright/test"
import { guardExternalRequests, login } from "./helpers"

/**
 * Mobile core flow (issue #8, spec 04 / spec 09): on a phone-sized viewport the
 * chat must not scroll horizontally, and the reduce-motion guard must collapse
 * every animation/transition duration. The shared fake backend and login
 * helper come from the standard E2E harness; this file needs no extra fixture.
 */
test.use({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  hasTouch: true,
})

test("mobile chat fits the viewport and honours reduced motion", async ({ page }) => {
  const external = guardExternalRequests(page)

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await login(page)

  // At a phone width the sidebar is a closed drawer, so the shared startChat
  // helper (which clicks its `new-chat`) cannot reach it. Use the app bar menu
  // instead, the same route shell-menu.spec.ts takes on this viewport.
  await page.getByTestId("app-bar-menu").click()
  await page.getByTestId("app-bar-menu-panel").getByTestId("menu-new-chat").click()
  await expect(page).toHaveURL(/\/c\/[^/]+$/)

  const noHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )
  expect(noHorizontalScroll).toBe(true)

  // The drawer normally animates its transform for 200ms; under the reduce
  // guard the global `* { transition-duration: 0.01ms !important }` wins.
  const drawerDuration = await page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="app-drawer"]')
    return drawer ? getComputedStyle(drawer).transitionDuration : null
  })
  expect(drawerDuration).not.toBeNull()
  expect(parseFloat(drawerDuration!)).toBeLessThan(0.01)

  // A recording-pill-style element (animate-pulse plus a 100ms width
  // transition) must be neutralised too. The probe reuses utility classes that
  // RecordingPill already ships in the CSS bundle, so it is deterministic.
  const pillDurations = await page.evaluate(() => {
    const element = document.createElement("div")
    element.className = "animate-pulse transition-[width] duration-100"
    document.body.appendChild(element)
    const style = getComputedStyle(element)
    const result = {
      animation: style.animationDuration,
      transition: style.transitionDuration,
    }
    element.remove()
    return result
  })
  expect(parseFloat(pillDurations.animation)).toBeLessThan(0.01)
  expect(parseFloat(pillDurations.transition)).toBeLessThan(0.01)

  expect(external).toEqual([])
})
