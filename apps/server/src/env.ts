import { randomBytes } from "node:crypto"
import type { FakeScenario } from "@openchat/contracts"
import { isFakeScenario } from "@openchat/opencode"

export type BackendMode = "fake" | "live"
export type AuthMode = "session" | "basic"

export interface EnvConfig {
  HOST: string
  PORT: number
  WORKSPACE_DIR: string
  BACKEND_MODE: BackendMode
  FAKE_SCENARIO: FakeScenario
  OPENCODE_URL: string
  OPENCODE_USERNAME: string
  OPENCODE_PASSWORD: string
  OPENCHAT_PASSWORD: string
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
  DICTATION_MAX_SECONDS: number
  DICTATION_MAX_BYTES: number
}

export interface LoadEnvOptions {
  /** Defaults to `console.warn`; tests pass a no-op. */
  warn?: (message: string) => void
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

const DEFAULT_PASSWORD = "openchat-dev"
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8787
const DEFAULT_TTL_SECONDS = 604_800
const DEFAULT_DICTATION_MAX_SECONDS = 120
const DEFAULT_DICTATION_MAX_BYTES = 26_214_400
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

function readBoolean(
  source: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = read(source, key)?.toLowerCase()
  return value === "1" || value === "true" || value === "on" || value === "yes"
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

  const configuredPassword = readSecret(source, "OPENCHAT_PASSWORD")
  const password = configuredPassword ?? DEFAULT_PASSWORD
  let secret = read(source, "SESSION_SECRET")
  const cookieSecure = readBoolean(source, "COOKIE_SECURE")
  const allowInsecureCookie = readBoolean(source, "ALLOW_INSECURE_COOKIE")

  if (source.NODE_ENV === "production") {
    // Refusals name the variable only; a secret value must never reach a log.
    if (!configuredPassword || configuredPassword === DEFAULT_PASSWORD) {
      throw new Error(
        "OPENCHAT_PASSWORD must be set to a non-default value when NODE_ENV=production",
      )
    }
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

  if (!configuredPassword) {
    warn("OPENCHAT_PASSWORD is unset; using the development password")
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

  return {
    HOST: read(source, "HOST") ?? DEFAULT_HOST,
    PORT: readNumber(source, "PORT", DEFAULT_PORT, warn),
    WORKSPACE_DIR: read(source, "WORKSPACE_DIR") ?? process.cwd(),
    BACKEND_MODE: backendMode,
    FAKE_SCENARIO: isFakeScenario(scenarioValue) ? scenarioValue : "default",
    OPENCODE_URL: read(source, "OPENCODE_URL") ?? "http://127.0.0.1:4096",
    OPENCODE_USERNAME: read(source, "OPENCODE_USERNAME") ?? "opencode",
    OPENCODE_PASSWORD: readSecret(source, "OPENCODE_PASSWORD") ?? "",
    OPENCHAT_PASSWORD: password,
    OPENCHAT_USER: read(source, "OPENCHAT_USER") ?? "owner",
    AUTH_MODE: authMode,
    SESSION_SECRET: secret,
    SESSION_TTL_SECONDS: readNumber(source, "SESSION_TTL_SECONDS", DEFAULT_TTL_SECONDS, warn),
    COOKIE_SECURE: cookieSecure,
    TRUST_PROXY: readBoolean(source, "TRUST_PROXY"),
    STT_URL: read(source, "STT_URL") ?? "",
    STT_API_KEY: readSecret(source, "STT_API_KEY") ?? "",
    DICTATION_MAX_SECONDS: readNumber(
      source,
      "DICTATION_MAX_SECONDS",
      DEFAULT_DICTATION_MAX_SECONDS,
      warn,
    ),
    DICTATION_MAX_BYTES: dictationMaxBytes,
  }
}
