import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(WEB_DIR, "..", "..")
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "openchat-e2e-"))
const REUSE_EXISTING = !process.env.CI

export default defineConfig({
  testDir: "./e2e",
  // The independent tests share one fake backend, so each test creates and
  // asserts on its own chat instead of relying on global counts.
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    // Dictation needs a capture device. Chromium's fake device needs no OS
    // microphone and auto-accepts the permission prompt; the context grant
    // covers the same request explicitly.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    permissions: ["microphone"],
  },
  webServer: [
    {
      command: "pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: "http://localhost:8787/healthz",
      reuseExistingServer: REUSE_EXISTING,
      timeout: 60_000,
      env: {
        PORT: "8787",
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
        STT_URL: "http://127.0.0.1:8899",
      },
    },
    {
      command: "pnpm --filter @openchat/web dev --port 5173 --strictPort",
      cwd: REPO_ROOT,
      url: "http://localhost:5173",
      reuseExistingServer: REUSE_EXISTING,
      timeout: 60_000,
    },
    {
      // `tsx` is not a dependency of the web package; Node ≥ 24 strips the
      // types of this erasable-syntax file on its own.
      command: "node e2e/fake-stt.ts",
      cwd: WEB_DIR,
      url: "http://127.0.0.1:8899/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
