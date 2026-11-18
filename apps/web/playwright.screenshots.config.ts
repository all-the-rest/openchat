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
import { CODE_STUB_ORIGIN, CODE_STUB_SECRET } from "./e2e/code-stub"

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(WEB_DIR, "..", "..")
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "openchat-ui-review-"))

// One seed file for the whole run: the `seed` project writes it, every worker
// project reads it. Absolute, so the setup test and the workers cannot resolve
// different paths from different working directories.
process.env.UI_REVIEW_SEEDS ??= join(WEB_DIR, "test-results", "ui-review-seeds.json")

export default defineConfig({
  testDir: "./screenshots",
  testMatch: "**/*.spec.ts",
  // The four viewport projects run in parallel. The captured sidebar stays
  // identical because the four seeded sessions are created once, up front, by
  // the `seed` project below — not once per worker.
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    video: "off",
    // The dictation variant needs a capture device. Chromium's fake device
    // needs no OS microphone and auto-accepts the permission prompt.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    permissions: ["microphone"],
  },
  // Playwright clears this directory at the start of a run. Keep it away from
  // the curated `ui-review/<state>/<viewport>/` captures that the spec writes
  // explicitly, or a fresh run would delete the reviewed screenshot set.
  outputDir: "test-results/ui-review-run",
  projects: [
    // Setup project: creates the four seeded sessions once and writes their
    // ids to UI_REVIEW_SEEDS. Playwright finishes a project before it starts a
    // project that depends on it, so every viewport below sees the same
    // sessions and therefore the same sidebar.
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "mobile",
      dependencies: ["seed"],
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "tablet",
      dependencies: ["seed"],
      use: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "desktop",
      dependencies: ["seed"],
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "wide",
      dependencies: ["seed"],
      use: { viewport: { width: 1920, height: 1080 } },
    },
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
        STT_URL: "http://127.0.0.1:8899",
        // The `/code` capture frames the stub host from the shared E2E suite;
        // the ticket audience and secret must match it exactly.
        CODE_HOST_ORIGIN: CODE_STUB_ORIGIN,
        CODE_TICKET_SECRET: CODE_STUB_SECRET,
      },
    },
    {
      command: "pnpm --filter @openchat/web dev --port 5173 --strictPort",
      cwd: REPO_ROOT,
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Same stub Code host the functional suite uses: the `/code` screenshot
      // and the E2E tests must frame the identical stand-in.
      command: "tsx e2e/code-stub.ts",
      cwd: WEB_DIR,
      url: `${CODE_STUB_ORIGIN}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { CODE_TICKET_SECRET: CODE_STUB_SECRET },
    },
    {
      // Same fake Whisper service the E2E dictation spec uses. Node ≥ 24
      // strips the types of this file itself, no loader needed.
      command: "node e2e/fake-stt.ts",
      cwd: WEB_DIR,
      url: "http://127.0.0.1:8899/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
