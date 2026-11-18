import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { FakeScenario } from "@openchat/contracts"
import { isFakeScenario } from "@openchat/opencode"
import { ARTIFACT_DIR_NAME, loadArtifactEnv } from "./env-artifacts"
import { loadWorkspaceEnv, type WorkspaceFileEnv } from "./env-workspace"
import { loadCredentialEnv } from "./env-auth"
import { sttModelDir } from "./models"
import { webDistDir } from "./static"

export type BackendMode = "fake" | "live"
export type AuthMode = "session" | "basic"

export interface EnvConfig extends WorkspaceFileEnv {
  HOST: string
  PORT: number
  WORKSPACE_DIR: string
  BACKEND_MODE: BackendMode
  FAKE_SCENARIO: FakeScenario
  /**
   * Fake mode only: `false` hides the app surface so the UI's "capability
   * absent" state is reachable in a browser. A live host decides for itself.
   */
  FAKE_APPS: boolean
  OPENCODE_URL: string
  /** Built SPA directory served by the BFF; empty in development. */
  WEB_DIST_DIR: string
  OPENCODE_USERNAME: string
  OPENCODE_PASSWORD: string
  /** Plaintext login credential; empty when `OPENCHAT_PASSWORD_HASH` is set. */
  OPENCHAT_PASSWORD: string
  /** bcrypt login hash; empty when `OPENCHAT_PASSWORD` is set. */
  OPENCHAT_PASSWORD_HASH: string
  OPENCHAT_USER: string
  AUTH_MODE: AuthMode
  SESSION_SECRET: string
  SESSION_TTL_SECONDS: number
  COOKIE_SECURE: boolean
  TRUST_PROXY: boolean
  /** Empty when no Whisper-compatible service is configured (dictation off). */
  STT_URL: string
  /** Sent upstream as a bearer token; empty when unset. Never logged. */
  STT_API_KEY: string
  /** Directory holding the pinned local model files served under `/models/`. */
  STT_MODEL_DIR: string
  DICTATION_MAX_SECONDS: number
  DICTATION_MAX_BYTES: number
  /** Empty when the deployment has no Code host (surface off). */
  CODE_HOST_ORIGIN: string
  /** Shared with the Code host; empty when the surface is not configured. */
  CODE_TICKET_SECRET: string
  CODE_TICKET_TTL_SECONDS: number
  CODE_STATUS_TIMEOUT_MS: number
  /** Public base URL of the artifact host; empty when artifacts are off. */
  ARTIFACT_HOST_URL: string
  /** Shared HMAC key for signed artifact URLs; empty when artifacts are off. */
  ARTIFACT_SIGNING_KEY: string
  /** Directory holding one subdirectory per artifact. */
  ARTIFACTS_DIR: string
  /**
   * Bearer token for `POST /internal/artifacts`, shared with the MCP tool.
   * Generated for a development boot; required in production once the surface
   * is configured.
   */
  ARTIFACT_INTERNAL_TOKEN: string
}

export interface LoadEnvOptions {
  /** Defaults to `console.warn`; tests pass a no-op. */
  warn?: (message: string) => void
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8787
const DEFAULT_TTL_SECONDS = 604_800
const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096"
const DEFAULT_DICTATION_MAX_SECONDS = 120
const DEFAULT_DICTATION_MAX_BYTES = 26_214_400
const DEFAULT_CODE_TICKET_TTL_SECONDS = 60
const DEFAULT_CODE_STATUS_TIMEOUT_MS = 2_000
/** Matches the Code host's probe bound: a status probe must not hold a socket. */
const MIN_CODE_STATUS_TIMEOUT_MS = 100
const MAX_CODE_STATUS_TIMEOUT_MS = 10_000
/** Matches `MAX_TICKET_TTL_SECONDS` in `@openchat/code-ticket`. */
const MAX_CODE_TICKET_TTL_SECONDS = 60
/**
 * Upper bound for a single upload. The route buffers the audio in memory, so a
 * misconfigured gigabyte cap must not become an OOM. 100 MiB leaves ample room
 * above the 25 MiB default.
 */
const DICTATION_MAX_BYTES_CEILING = 104_857_600

function read(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Secrets keep their exact characters; only an empty value counts as unset. */
function readSecret(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined || value.trim().length === 0) return undefined
  return value
}

function readNumber(
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
  warn: (message: string) => void,
): number {
  const value = read(source, key)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warn(`${key} must be a positive integer; using the default`)
    return fallback
  }
  return parsed
}

/**
 * A TCP port; anything outside `1..65535` would fail later inside `listen`.
 */
function readPort(
  source: Record<string, string | undefined>,
  fallback: number,
  warn: (message: string) => void,
): number {
  const value = read(source, "PORT")
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    warn("PORT must be an integer between 1 and 65535; using the default")
    return fallback
  }
  return parsed
}

/**
 * Validates the upstream Code host. A typo must fail the boot, not silently
 * fall back to localhost: the app would otherwise talk to the wrong host.
 * Embedded credentials are rejected because the Basic header comes from
 * `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` and must never sit in a URL.
 */
function readOpencodeUrl(source: Record<string, string | undefined>): string {
  const raw = read(source, "OPENCODE_URL")
  if (!raw) return DEFAULT_OPENCODE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("OPENCODE_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCODE_URL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error(
      "OPENCODE_URL must not embed credentials; use OPENCODE_USERNAME and OPENCODE_PASSWORD",
    )
  }
  // A query or fragment would be dropped by URL resolution anyway; strip the
  // trailing slash and any search/hash so the value equals what is used.
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

function readBoolean(
  source: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = read(source, key)?.toLowerCase()
  return value === "1" || value === "true" || value === "on" || value === "yes"
}

/**
 * The Code host origin is optional: an empty value means the surface is not
 * configured and the UI hides its switch. When set it must be a bare origin,
 * because it is both the ticket audience and the base of the entry URL. The
 * rules mirror `apps/code-host/src/env.ts`; the value is never echoed.
 */
function readCodeHostOrigin(source: Record<string, string | undefined>): string {
  const raw = read(source, "CODE_HOST_ORIGIN")
  if (!raw) return ""
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("CODE_HOST_ORIGIN must be an absolute http(s) origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CODE_HOST_ORIGIN must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("CODE_HOST_ORIGIN must not embed credentials")
  }
  if (url.search || url.hash) {
    throw new Error("CODE_HOST_ORIGIN must not carry a query or fragment")
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("CODE_HOST_ORIGIN must be an origin without a path")
  }
  return url.origin
}

/**
 * Reads and validates process configuration. Warnings are printed once at
 * boot and never contain credentials.
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvConfig {
  const source = options.source ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(`[openchat] ${message}`))

  const backendMode: BackendMode = read(source, "BACKEND_MODE") === "live" ? "live" : "fake"
  const authMode: AuthMode = read(source, "AUTH_MODE") === "basic" ? "basic" : "session"

  if (backendMode === "fake" && source.NODE_ENV === "production") {
    throw new Error("BACKEND_MODE=fake is not allowed with NODE_ENV=production")
  }
  if (backendMode === "live" && !readSecret(source, "OPENCODE_PASSWORD")) {
    warn("BACKEND_MODE=live without OPENCODE_PASSWORD; OpenCode will answer 401")
  }

  const scenarioValue = read(source, "FAKE_SCENARIO") ?? "default"
  if (!isFakeScenario(scenarioValue)) {
    warn(`FAKE_SCENARIO=${scenarioValue} is unknown; using default`)
  }

  // `off` makes the fake backend answer as a host without an app surface, so
  // the UI's hidden state is browsable. Only `BACKEND_MODE=fake` reads it.
  const fakeAppsValue = read(source, "FAKE_APPS")?.toLowerCase() ?? "on"
  if (fakeAppsValue !== "on" && fakeAppsValue !== "off") {
    warn("FAKE_APPS must be on or off; using on")
  }

  const credentials = loadCredentialEnv({
    password: readSecret(source, "OPENCHAT_PASSWORD"),
    passwordHash: readSecret(source, "OPENCHAT_PASSWORD_HASH"),
  })
  let secret = read(source, "SESSION_SECRET")
  const cookieSecure = readBoolean(source, "COOKIE_SECURE")
  const allowInsecureCookie = readBoolean(source, "ALLOW_INSECURE_COOKIE")
  const production = source.NODE_ENV === "production"

  const codeHostOrigin = readCodeHostOrigin(source)
  let codeTicketSecret = readSecret(source, "CODE_TICKET_SECRET")
  let codeTicketTtl = readNumber(
    source,
    "CODE_TICKET_TTL_SECONDS",
    DEFAULT_CODE_TICKET_TTL_SECONDS,
    warn,
  )
  if (codeTicketTtl > MAX_CODE_TICKET_TTL_SECONDS) {
    if (production) {
      throw new Error(
        `CODE_TICKET_TTL_SECONDS must not exceed ${MAX_CODE_TICKET_TTL_SECONDS} seconds ` +
          "when NODE_ENV=production",
      )
    }
    warn(
      `CODE_TICKET_TTL_SECONDS is above the ${MAX_CODE_TICKET_TTL_SECONDS} s ceiling; ` +
        "using the ceiling",
    )
    codeTicketTtl = MAX_CODE_TICKET_TTL_SECONDS
  }
  if (codeHostOrigin) {
    if (production && new URL(codeHostOrigin).protocol !== "https:") {
      throw new Error("CODE_HOST_ORIGIN must use https when NODE_ENV=production")
    }
    if (!codeTicketSecret) {
      if (production) {
        throw new Error(
          "CODE_TICKET_SECRET must be set when CODE_HOST_ORIGIN is configured " +
            "and NODE_ENV=production",
        )
      }
      codeTicketSecret = randomBytes(32).toString("base64url")
      warn("CODE_TICKET_SECRET is unset; generated an ephemeral secret for this boot")
    }
  }

  // The artifact surface needs both halves; `loadArtifactEnv` validates them
  // together and warns when a deployment configured only one.
  const artifacts = loadArtifactEnv(
    {
      hostUrl: read(source, "ARTIFACT_HOST_URL"),
      signingKey: readSecret(source, "ARTIFACT_SIGNING_KEY"),
      internalToken: readSecret(source, "ARTIFACT_INTERNAL_TOKEN"),
    },
    { production, warn },
  )
  const workspaceDir = read(source, "WORKSPACE_DIR") ?? process.cwd()
  const workspaceFiles = loadWorkspaceEnv(source, warn)

  if (authMode === "basic" && credentials.passwordHash) {
    throw new Error(
      "AUTH_MODE=basic requires OPENCHAT_PASSWORD; HTTP Basic cannot verify a bcrypt hash",
    )
  }

  if (source.NODE_ENV === "production") {
    // Refusals name the variable only; a secret value must never reach a log.
    if (!secret) {
      throw new Error("SESSION_SECRET must be set when NODE_ENV=production")
    }
    if (authMode === "session" && !cookieSecure && !allowInsecureCookie) {
      throw new Error(
        "COOKIE_SECURE=1 is required when NODE_ENV=production with AUTH_MODE=session " +
          "(or set AUTH_MODE=basic or ALLOW_INSECURE_COOKIE=1)",
      )
    }
    if (authMode === "session" && !cookieSecure) {
      warn("ALLOW_INSECURE_COOKIE=1: the session cookie is sent without Secure")
    }
  }

  if (!secret) {
    secret = randomBytes(32).toString("base64url")
    warn("SESSION_SECRET is unset; generated an ephemeral secret for this boot")
  }

  let dictationMaxBytes = readNumber(
    source,
    "DICTATION_MAX_BYTES",
    DEFAULT_DICTATION_MAX_BYTES,
    warn,
  )
  if (dictationMaxBytes > DICTATION_MAX_BYTES_CEILING) {
    warn(`DICTATION_MAX_BYTES is above the 100 MiB ceiling; using the ceiling`)
    dictationMaxBytes = DICTATION_MAX_BYTES_CEILING
  }

  let codeStatusTimeoutMs = readNumber(
    source,
    "CODE_STATUS_TIMEOUT_MS",
    DEFAULT_CODE_STATUS_TIMEOUT_MS,
    warn,
  )
  if (codeStatusTimeoutMs < MIN_CODE_STATUS_TIMEOUT_MS) {
    warn(
      `CODE_STATUS_TIMEOUT_MS is below the ${MIN_CODE_STATUS_TIMEOUT_MS} ms floor; ` +
        "using the floor",
    )
    codeStatusTimeoutMs = MIN_CODE_STATUS_TIMEOUT_MS
  } else if (codeStatusTimeoutMs > MAX_CODE_STATUS_TIMEOUT_MS) {
    warn(
      `CODE_STATUS_TIMEOUT_MS is above the ${MAX_CODE_STATUS_TIMEOUT_MS} ms ceiling; ` +
        "using the ceiling",
    )
    codeStatusTimeoutMs = MAX_CODE_STATUS_TIMEOUT_MS
  }

  return {
    HOST: read(source, "HOST") ?? DEFAULT_HOST,
    PORT: readPort(source, DEFAULT_PORT, warn),
    WORKSPACE_DIR: workspaceDir,
    ...workspaceFiles,
    BACKEND_MODE: backendMode,
    FAKE_SCENARIO: isFakeScenario(scenarioValue) ? scenarioValue : "default",
    FAKE_APPS: fakeAppsValue !== "off",
    OPENCODE_URL: readOpencodeUrl(source),
    WEB_DIST_DIR: webDistDir(source),
    OPENCODE_USERNAME: read(source, "OPENCODE_USERNAME") ?? "opencode",
    OPENCODE_PASSWORD: readSecret(source, "OPENCODE_PASSWORD") ?? "",
    OPENCHAT_PASSWORD: credentials.password,
    OPENCHAT_PASSWORD_HASH: credentials.passwordHash,
    OPENCHAT_USER: read(source, "OPENCHAT_USER") ?? "owner",
    AUTH_MODE: authMode,
    SESSION_SECRET: secret,
    SESSION_TTL_SECONDS: readNumber(source, "SESSION_TTL_SECONDS", DEFAULT_TTL_SECONDS, warn),
    COOKIE_SECURE: cookieSecure,
    TRUST_PROXY: readBoolean(source, "TRUST_PROXY"),
    STT_URL: read(source, "STT_URL") ?? "",
    STT_API_KEY: readSecret(source, "STT_API_KEY") ?? "",
    STT_MODEL_DIR: sttModelDir(source),
    DICTATION_MAX_SECONDS: readNumber(
      source,
      "DICTATION_MAX_SECONDS",
      DEFAULT_DICTATION_MAX_SECONDS,
      warn,
    ),
    DICTATION_MAX_BYTES: dictationMaxBytes,
    CODE_HOST_ORIGIN: codeHostOrigin,
    CODE_TICKET_SECRET: codeTicketSecret ?? "",
    CODE_TICKET_TTL_SECONDS: codeTicketTtl,
    CODE_STATUS_TIMEOUT_MS: codeStatusTimeoutMs,
    ARTIFACT_HOST_URL: artifacts.hostUrl,
    ARTIFACT_SIGNING_KEY: artifacts.signingKey,
    ARTIFACTS_DIR: read(source, "ARTIFACTS_DIR") ?? join(workspaceDir, ARTIFACT_DIR_NAME),
    ARTIFACT_INTERNAL_TOKEN: artifacts.internalToken,
  }
}
