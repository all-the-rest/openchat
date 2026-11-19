/**
 * The memory MCP tool's own configuration. Two variables, both shared with the
 * BFF process; a missing token is a startup failure, because every memory call
 * would answer 401 otherwise. Refusals name variables only, never values.
 */

const DEFAULT_BFF_URL = "http://127.0.0.1:8787"

export interface ToolEnv {
  /** Base URL of the BFF; a path prefix is allowed, a trailing slash is not kept. */
  bffUrl: string
  /** Shared bearer token for `POST /internal/memory`. Never logged. */
  token: string
}

export interface LoadToolEnvOptions {
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

function read(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readBffUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_BFF_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("OPENCHAT_BFF_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCHAT_BFF_URL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("OPENCHAT_BFF_URL must not embed credentials")
  }
  if (url.search || url.hash) {
    throw new Error("OPENCHAT_BFF_URL must not carry a query or fragment")
  }
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

/** Refusals and warnings name the variable only, never a value. */
export function loadToolEnv(options: LoadToolEnvOptions = {}): ToolEnv {
  const source = options.source ?? process.env
  const bffUrl = readBffUrl(read(source, "OPENCHAT_BFF_URL"))
  const token = read(source, "MEMORY_INTERNAL_TOKEN")
  if (!token) {
    throw new Error(
      "MEMORY_INTERNAL_TOKEN must be set for the memory tools; " +
        "it is the same token the BFF reads",
    )
  }
  return { bffUrl, token }
}
