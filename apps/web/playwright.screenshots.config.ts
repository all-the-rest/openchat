// Playwright config for the UI-review screenshot set.
//
// Deliberately SEPARATE from playwright.config.ts: this set only captures
// screenshots and never runs inside the normal E2E suite. It boots the same
// fake backend, so a run costs no provider quota and needs no network.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(WEB_DIR, "..", "..")
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "openchat-ui-review-"))

export default defineConfig({
  testDir: "./screenshots",
  testMatch: "**/*.spec.ts",
  // One worker keeps the manifest order (and therefore the empty sidebar on the
  // landing route) deterministic, and avoids interleaved scroll captures.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    video: "off",
  },
  // Playwright clears this directory at the start of a run. Keep it away from
  // the curated `ui-review/<state>/<viewport>/` captures that the spec writes
  // explicitly, or a fresh run would delete the reviewed screenshot set.
  outputDir: "test-results/ui-review-run",
  projects: [
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "tablet",
      use: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "wide", use: { viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: [
    {
      command: "pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: "http://localhost:8787/healthz",
      // No reuse: a stale server would silently produce screenshots of older code.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: "8787",
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
      },
    },
    {
      command: "pnpm --filter @openchat/web dev --port 5173 --strictPort",
      cwd: REPO_ROOT,
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
