/**
 * The Python tool's own configuration. The BFF values are shared with the
 * artifact tool; `OPENCHAT_PYTHON` is an operator choice between the image's
 * `/usr/bin/python3` and a development virtualenv. No value is ever logged.
 */

const DEFAULT_BFF_URL = "http://127.0.0.1:8787"

export interface ToolEnv {
  /** Base URL of the BFF, e.g. `http://127.0.0.1:8787`. */
  bffUrl: string
  /** Shared bearer token for the internal artifact routes. Never logged. */
  token: string
  /** Interpreter command; `python3` from PATH by default. */
  python: string
}

export interface DocumentsToolEnv extends ToolEnv {
  /** Root of `chats/<session>/files`; templates are read only below it. */
  workspaceDir: string
  /** Base URL of the headless documents service. */
  documentsUrl: string
  /** Bearer token for the documents service, distinct from the BFF token. */
  documentsToken: string
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

/** Refusals name the variable only, never a value. */
export function loadToolEnv(options: LoadToolEnvOptions = {}): ToolEnv {
  const source = options.source ?? process.env
  const bffUrl = readBffUrl(read(source, "OPENCHAT_BFF_URL"))
  const token = read(source, "ARTIFACT_INTERNAL_TOKEN")
  if (!token) {
    throw new Error(
      "ARTIFACT_INTERNAL_TOKEN must be set for the document tools; " +
        "it is the same token the BFF reads",
    )
  }
  return { bffUrl, token, python: read(source, "OPENCHAT_PYTHON") ?? "python3" }
}

function readDirectory(raw: string | undefined): string {
  const value = raw ?? "/workspace"
  if (!value.startsWith("/") || value.includes("\u0000")) {
    throw new Error("WORKSPACE_DIR must be an absolute path")
  }
  return value.replace(/\/+$/, "") || "/"
}

function readDocumentsUrl(raw: string | undefined): string {
  if (!raw) return "http://documents:8099"
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("DOCUMENTS_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DOCUMENTS_URL must use http or https")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DOCUMENTS_URL must not carry credentials, a query or a fragment")
  }
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

/**
 * Same BFF values as `loadToolEnv`, plus the workspace root and the documents
 * service pair. A missing token is a startup failure, never a silent 401.
 */
export function loadDocumentsToolEnv(options: LoadToolEnvOptions = {}): DocumentsToolEnv {
  const source = options.source ?? process.env
  const base = loadToolEnv({ source })
  const documentsToken = read(source, "DOCUMENTS_TOKEN")
  if (!documentsToken) throw new Error("DOCUMENTS_TOKEN must be set for the documents tools")
  const documentsUrl = readDocumentsUrl(read(source, "DOCUMENTS_URL"))
  return {
    ...base,
    workspaceDir: readDirectory(read(source, "WORKSPACE_DIR")),
    documentsUrl,
    documentsToken,
  }
}
