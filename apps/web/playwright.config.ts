import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"
import {
  E2E_ARTIFACT_CREATED_AT,
  E2E_ARTIFACT_FRAME_ANCESTORS,
  E2E_ARTIFACT_HOST_URL,
  E2E_ARTIFACT_HTML,
  E2E_ARTIFACT_ID,
  E2E_ARTIFACT_SIGNING_KEY,
  E2E_ARTIFACT_TITLE,
  E2E_IMAGE_CREATED_AT,
  E2E_IMAGE_ID,
  E2E_IMAGE_PNG,
  E2E_IMAGE_TITLE,
  E2E_PDF,
  E2E_PDF_CREATED_AT,
  E2E_PDF_ID,
  E2E_PDF_TITLE,
} from "./e2e/artifact-fixture"
import { CODE_STUB_ORIGIN, CODE_STUB_SECRET } from "./e2e/code-stub"
import {
  HOST_STATUS_BFF_ORIGIN,
  HOST_STATUS_BFF_PORT,
  HOST_STATUS_WEB_PORT,
} from "./e2e/host-status-fixture"
import {
  LOCAL_STT_BFF_ORIGIN,
  LOCAL_STT_BFF_PORT,
  LOCAL_STT_MODEL_DIR,
  LOCAL_STT_WEB_PORT,
} from "./e2e/local-stt-fixture"
import {
  ONBOARDING_BFF_ORIGIN,
  ONBOARDING_BFF_PORT,
  ONBOARDING_WEB_PORT,
} from "./e2e/onboarding-fixture"
import { PWA_ORIGIN, PWA_PORT } from "./e2e/pwa-fixture"

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(WEB_DIR, "..", "..")
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "openchat-e2e-"))

// Seed the artifact store before the BFF and host start. Content-addressed like
// the real store, so `/api/artifacts` lists exactly one deterministic document
// and the artifact host serves it over a signed URL without any network.
const ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "openchat-e2e-artifacts-"))
const SEEDED_ARTIFACT_DIR = join(ARTIFACTS_DIR, E2E_ARTIFACT_ID)
mkdirSync(SEEDED_ARTIFACT_DIR, { recursive: true })
writeFileSync(join(SEEDED_ARTIFACT_DIR, "index.html"), E2E_ARTIFACT_HTML)
writeFileSync(
  join(SEEDED_ARTIFACT_DIR, "meta.json"),
  JSON.stringify({
    title: E2E_ARTIFACT_TITLE,
    bytes: Buffer.byteLength(E2E_ARTIFACT_HTML),
    createdAt: E2E_ARTIFACT_CREATED_AT,
  }),
)
// One image and one PDF join the document, seeded the same way: id-named
// directory, exact bytes and a sidecar carrying the sniffed MIME.
for (const media of [
  {
    id: E2E_IMAGE_ID,
    bytes: E2E_IMAGE_PNG,
    title: E2E_IMAGE_TITLE,
    mime: "image/png",
    createdAt: E2E_IMAGE_CREATED_AT,
  },
  {
    id: E2E_PDF_ID,
    bytes: E2E_PDF,
    title: E2E_PDF_TITLE,
    mime: "application/pdf",
    createdAt: E2E_PDF_CREATED_AT,
  },
]) {
  const directory = join(ARTIFACTS_DIR, media.id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "artifact.bin"), media.bytes)
  writeFileSync(
    join(directory, "meta.json"),
    JSON.stringify({
      title: media.title,
      bytes: media.bytes.byteLength,
      createdAt: media.createdAt,
      mime: media.mime,
    }),
  )
}

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
        // One seeded document; the same key and directory reach the real
        // artifact host below.
        ARTIFACT_HOST_URL: E2E_ARTIFACT_HOST_URL,
        ARTIFACT_SIGNING_KEY: E2E_ARTIFACT_SIGNING_KEY,
        ARTIFACTS_DIR,
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
      // The real host serves the seeded bytes with its CSP and the documented
      // two-header sandbox. It shares only the key and the directory with the
      // BFF, exactly like a deployment.
      command: "pnpm --filter @openchat/artifact-host start",
      cwd: REPO_ROOT,
      url: `${E2E_ARTIFACT_HOST_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        HOST: "127.0.0.1",
        PORT: "4100",
        ARTIFACT_SIGNING_KEY: E2E_ARTIFACT_SIGNING_KEY,
        ARTIFACTS_DIR,
        ARTIFACT_FRAME_ANCESTORS: E2E_ARTIFACT_FRAME_ANCESTORS,
      },
    },
    {
      // A private fake stack for the host-outage spec. Flipping the shared
      // backend down would break the four parallel workers, so this pair owns
      // its own in-memory host and can stop and restart it mid-test.
      command: "pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: `${HOST_STATUS_BFF_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(HOST_STATUS_BFF_PORT),
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
        OPENCODE_PASSWORD: "unused-in-fake-mode",
      },
    },
    {
      command: `pnpm --filter @openchat/web dev --port ${HOST_STATUS_WEB_PORT} --strictPort`,
      cwd: REPO_ROOT,
      url: `http://localhost:${HOST_STATUS_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { OPENCHAT_BFF_TARGET: HOST_STATUS_BFF_ORIGIN },
    },
    {
      // First-run stack: a deterministic host that starts without a model, so
      // the onboarding card is reachable without a real provider.
      command: "pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: `${ONBOARDING_BFF_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(ONBOARDING_BFF_PORT),
        BACKEND_MODE: "fake",
        FAKE_MODELS: "off",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
      },
    },
    {
      command: `pnpm --filter @openchat/web dev --port ${ONBOARDING_WEB_PORT} --strictPort`,
      cwd: REPO_ROOT,
      url: `http://localhost:${ONBOARDING_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { OPENCHAT_BFF_TARGET: ONBOARDING_BFF_ORIGIN },
    },
    {
      // PWA specs need a production build: the SW is injected and served by the
      // BFF from apps/web/dist, on one origin together with the fake API.
      command: "pnpm --filter @openchat/web build && pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: `${PWA_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(PWA_PORT),
        WEB_DIST_DIR: join(REPO_ROOT, "apps", "web", "dist"),
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
      },
    },
    {
      // On-device dictation stack: a complete model directory, no STT_URL.
      // The worker is stubbed by the spec, so no weight bytes are read here.
      command: "pnpm --filter @openchat/server start",
      cwd: REPO_ROOT,
      url: `${LOCAL_STT_BFF_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(LOCAL_STT_BFF_PORT),
        BACKEND_MODE: "fake",
        OPENCHAT_PASSWORD: "test-password",
        SESSION_SECRET: "test-secret",
        WORKSPACE_DIR,
        STT_MODEL_DIR: LOCAL_STT_MODEL_DIR,
      },
    },
    {
      command: `pnpm --filter @openchat/web dev --port ${LOCAL_STT_WEB_PORT} --strictPort`,
      cwd: REPO_ROOT,
      url: `http://localhost:${LOCAL_STT_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { OPENCHAT_BFF_TARGET: LOCAL_STT_BFF_ORIGIN },
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
