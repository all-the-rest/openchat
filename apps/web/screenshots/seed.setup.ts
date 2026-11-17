// Playwright setup project for the ui-review screenshot set.
//
// `playwright.screenshots.config.ts` registers this file as the `seed` project
// and makes every viewport project depend on it. Playwright completes a
// project's tests before it starts a dependent project, so the seed file at
// `UI_REVIEW_SEEDS` exists before the first capture test runs — and the four
// seeded sessions are created once before the viewport projects start instead
// of once per worker.

import { test } from "@playwright/test"
import { seedAll } from "./seeds"

// Tagged like the captures so the documented `--grep @screenshot` filter keeps
// the seed. A different `--grep` can skip it; the viewport projects then reuse
// the previous run's seed file (see `ui-review.config.ts`), so run the whole
// set.
test("seed the ui-review scenarios", { tag: ["@screenshot"] }, async () => {
  await seedAll()
})
