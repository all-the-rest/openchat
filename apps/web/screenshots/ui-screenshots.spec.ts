// Generic manifest-driven screenshot spec for the ui-review skill.
//
// Reads the route/state/viewport/variant matrix from `ui-review.config.ts` and
// captures viewport-height SECTION captures, plus a full-page PNG for short
// pages that scroll the window. Route specifics (seeds, nav steps, auth,
// scroller selectors, variants) live in the manifest; the capture machinery
// lives in `capture.ts` / `scroller.ts` and the page flow in `harness.ts`.
//
// Adapted for OpenChat: the login flow asks for a username and a password, and
// the authenticated app keeps an SSE connection open, so settling waits for DOM
// + key UI instead of `networkidle` (which would never be reached).
//
// All tests are tagged `@screenshot`; the set is separate from the functional
// E2E suite and runs in CI as the second slow step (same e2e job, after the
// functional suite), with `apps/web/ui-review/` uploaded as an artifact.

import { test } from "@playwright/test"
import { viewportForPage } from "./capture"
import { captureRoute } from "./harness"
import { routes } from "./ui-review.config"
import type { UiReviewVariant, UiReviewViewport } from "./ui-review.config"

const DEFAULT_VIEWPORTS: UiReviewViewport[] = ["desktop", "mobile"]

for (const route of routes) {
  for (const state of route.states) {
    for (const viewport of route.viewports ?? DEFAULT_VIEWPORTS) {
      const variants: Array<UiReviewVariant | undefined> = [undefined, ...(route.variants ?? [])]
      for (const variant of variants) {
        if (variant?.viewports && !variant.viewports.includes(viewport)) continue
        const name = `${route.name} (${state}, ${viewport}${variant ? `, ${variant.name}` : ""})`
        test(`screenshot ${name}`, { tag: ["@screenshot"] }, async ({ page }) => {
          const actualViewport = viewportForPage(page)
          test.skip(
            actualViewport.label !== viewport,
            `actual viewport ${actualViewport.width}x${actualViewport.height} maps to ${actualViewport.label}, not ${viewport}`,
          )
          await captureRoute(page, route, state, viewport, variant)
        })
      }
    }
  }
}
