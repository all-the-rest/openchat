import { randomBytes } from "node:crypto"
import { MAX_TICKET_TTL_SECONDS } from "@openchat/code-ticket"

export interface EnvConfig {
  HOST: string
  PORT: number
  OPENCODE_URL: string
  OPENCODE_USERNAME: string
  OPENCODE_PASSWORD: string
  /** Public origin of this Code host; also the ticket audience. */
  CODE_HOST_ORIGIN: string
  /** Public origin of the app; the only origin allowed to frame the UI. */
  APP_ORIGIN: string
  /** Signing key for tickets and the derived Code session cookie. */
  CODE_TICKET_SECRET: string
  CODE_TICKET_TTL_SECONDS: number
  CODE_SESSION_TTL_SECONDS: number
  COOKIE_SECURE: boolean
  ALLOW_INSECURE_COOKIE: boolean
  TRUST_PROXY: boolean
}

export interface LoadEnvOptions {
  /** Defaults to `console.warn`; tests pass a no-op. */
  warn?: (message: string) => void
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8090
const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096"
const DEFAULT_CODE_HOST_ORIGIN = "http://127.0.0.1:8090"
const DEFAULT_APP_ORIGIN = "http://127.0.0.1:8787"
const DEFAULT_TICKET_TTL_SECONDS = 60
const DEFAULT_SESSION_TTL_SECONDS = 43_200

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
 * A public origin is a scheme, host and optional port only. A path would make
 * `frame-ancestors` and `postMessage` compare the wrong string, so reject it
 * at boot instead of silently normalising it away.
 */
function parseOrigin(value: string, key: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} must be an absolute http(s) origin`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must use http or https`)
  }
  if (url.username || url.password) {
    throw new Error(`${key} must not embed credentials`)
  }
  if (url.search || url.hash) {
    throw new Error(`${key} must not carry a query or fragment`)
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${key} must be an origin without a path`)
  }
  return url.origin
}

function loadOrigin(
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
  warn: (message: string) => void,
  production: boolean,
): string {
  const raw = read(source, key)
  if (!raw) {
    if (production) throw new Error(`${key} must be set when NODE_ENV=production`)
    warn(`${key} is unset; using the development default`)
    return fallback
  }
  return parseOrigin(raw, key)
}

/**
 * Validates the upstream Code host. A typo must fail the boot, not silently
 * fall back to localhost: the proxy would otherwise talk to the wrong host.
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
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

/**
 * Reads and validates the Code host configuration. Warnings are printed once
 * at boot and never contain a variable's value.
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvConfig {
  const source = options.source ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(`[code-host] ${message}`))
  const production = source.NODE_ENV === "production"

  const configuredSecret = readSecret(source, "CODE_TICKET_SECRET")
  const configuredPassword = readSecret(source, "OPENCODE_PASSWORD")
  const cookieSecure = readBoolean(source, "COOKIE_SECURE")
  const allowInsecureCookie = readBoolean(source, "ALLOW_INSECURE_COOKIE")

  const codeHostOrigin = loadOrigin(
    source,
    "CODE_HOST_ORIGIN",
    DEFAULT_CODE_HOST_ORIGIN,
    warn,
    production,
  )
  const appOrigin = loadOrigin(source, "APP_ORIGIN", DEFAULT_APP_ORIGIN, warn, production)

  let ticketTtl = readNumber(
    source,
    "CODE_TICKET_TTL_SECONDS",
    DEFAULT_TICKET_TTL_SECONDS,
    warn,
  )

  if (production) {
    // Refusals name the variable only; a value must never reach a log.
    if (!configuredSecret) {
      throw new Error("CODE_TICKET_SECRET must be set when NODE_ENV=production")
    }
    if (!configuredPassword) {
      throw new Error("OPENCODE_PASSWORD must be set when NODE_ENV=production")
    }
    if (new URL(appOrigin).protocol !== "https:") {
      throw new Error("APP_ORIGIN must use https when NODE_ENV=production")
    }
    if (new URL(codeHostOrigin).protocol !== "https:") {
      throw new Error("CODE_HOST_ORIGIN must use https when NODE_ENV=production")
    }
    if (!cookieSecure && !allowInsecureCookie) {
      throw new Error(
        "COOKIE_SECURE=1 is required when NODE_ENV=production (or set ALLOW_INSECURE_COOKIE=1)",
      )
    }
    if (ticketTtl > MAX_TICKET_TTL_SECONDS) {
      throw new Error(
        `CODE_TICKET_TTL_SECONDS must not exceed ${MAX_TICKET_TTL_SECONDS} when NODE_ENV=production`,
      )
    }
    if (!cookieSecure) {
      warn("ALLOW_INSECURE_COOKIE=1: the Code session cookie is sent without Secure")
    }
  } else if (ticketTtl > MAX_TICKET_TTL_SECONDS) {
    warn(`CODE_TICKET_TTL_SECONDS is above ${MAX_TICKET_TTL_SECONDS}; using ${MAX_TICKET_TTL_SECONDS}`)
    ticketTtl = MAX_TICKET_TTL_SECONDS
  }

  if (!configuredPassword) {
    warn("OPENCODE_PASSWORD is unset; OpenCode will answer 401")
  }

  let secret = configuredSecret
  if (!secret) {
    secret = randomBytes(32).toString("base64url")
    warn("CODE_TICKET_SECRET is unset; generated an ephemeral secret for this boot")
  }

  return {
    HOST: read(source, "HOST") ?? DEFAULT_HOST,
    PORT: readNumber(source, "PORT", DEFAULT_PORT, warn),
    OPENCODE_URL: readOpencodeUrl(source),
    OPENCODE_USERNAME: read(source, "OPENCODE_USERNAME") ?? "opencode",
    OPENCODE_PASSWORD: configuredPassword ?? "",
    CODE_HOST_ORIGIN: codeHostOrigin,
    APP_ORIGIN: appOrigin,
    CODE_TICKET_SECRET: secret,
    CODE_TICKET_TTL_SECONDS: ticketTtl,
    CODE_SESSION_TTL_SECONDS: readNumber(
      source,
      "CODE_SESSION_TTL_SECONDS",
      DEFAULT_SESSION_TTL_SECONDS,
      warn,
    ),
    COOKIE_SECURE: cookieSecure,
    ALLOW_INSECURE_COOKIE: allowInsecureCookie,
    TRUST_PROXY: readBoolean(source, "TRUST_PROXY"),
  }
}
