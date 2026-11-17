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
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
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
      },
    },
    {
      command: "pnpm --filter @openchat/web dev --port 5173 --strictPort",
      cwd: REPO_ROOT,
      url: "http://localhost:5173",
      reuseExistingServer: REUSE_EXISTING,
      timeout: 60_000,
    },
  ],
})
