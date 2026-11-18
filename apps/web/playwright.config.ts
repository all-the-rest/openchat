import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"
import { CODE_STUB_ORIGIN, CODE_STUB_SECRET } from "./e2e/code-stub"

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
      // Never reuse: this server needs CODE_HOST_ORIGIN, CODE_TICKET_SECRET and
      // TRUST_PROXY below. A developer's running BFF would ignore them, and the
      // suite would fail with a misleading 429 instead of saying so.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: "8787",
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
        STT_URL: "http://127.0.0.1:8899",
        // The stub Code host below stands in for apps/code-host; the ticket
        // audience and the secret must match it exactly.
        CODE_HOST_ORIGIN: CODE_STUB_ORIGIN,
        CODE_TICKET_SECRET: CODE_STUB_SECRET,
        // The code spec presents a per-test `X-Forwarded-For` client, so the
        // BFF's per-address ticket budget (20 mints/min) is per simulated user
        // instead of shared by the whole parallel suite. See e2e/code.spec.ts.
        TRUST_PROXY: "1",
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
      // Stub Code host: redeems the real tickets the BFF mints, so the switch,
      // deep links and the frame are exercised end to end without OpenCode.
      // `tsx` resolves the TypeScript sources of `@openchat/code-ticket`.
      command: "tsx e2e/code-stub.ts",
      cwd: WEB_DIR,
      url: `${CODE_STUB_ORIGIN}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { CODE_TICKET_SECRET: CODE_STUB_SECRET },
    },
    {
      // Node ≥ 24 strips the types of this erasable-syntax file on its own;
      // it has no dependency on the ticket package, so no loader is needed.
      command: "node e2e/fake-stt.ts",
      cwd: WEB_DIR,
      url: "http://127.0.0.1:8899/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
