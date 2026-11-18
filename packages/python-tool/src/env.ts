import { loadToolEnv } from "@openchat/artifact-tool/env"
import type { ToolEnv } from "@openchat/artifact-tool/env"

/**
 * The tool's own configuration. The BFF URL and the artifact token are the same
 * two values the app tool reads. `OPENCHAT_PYTHON` is the interpreter,
 * `WORKSPACE_DIR` is the root of the chat files, and the last two values point
 * at the headless documents service on the internal compose network.
 */

export const DEFAULT_PYTHON = "python3"
export const DEFAULT_WORKSPACE_DIR = "/workspace"
export const DEFAULT_DOCUMENTS_URL = "http://documents:8099"

export interface DocumentsEnv extends ToolEnv {
  /** Interpreter command or absolute path; never model input. */
  python: string
  /** Root containing `chats/<session>/files`; templates are read only here. */
  workspaceDir: string
  /** Base URL of the Debian documents service; no trailing slash. */
  documentsUrl: string
  /** Bearer token for the documents service, distinct from the BFF token. */
  documentsToken: string
}

export interface LoadDocumentsEnvOptions {
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

function read(source: Record<string, string | undefined>, key: string): string | undefined {
  const raw = source[key]
  if (raw === undefined) return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

function readCommand(raw: string | undefined): string {
  if (!raw) return DEFAULT_PYTHON
  if (raw.includes("\u0000") || raw.includes("\n") || raw.includes("\r")) {
    throw new Error("OPENCHAT_PYTHON must be one command or path")
  }
  return raw
}

function readDirectory(raw: string | undefined): string {
  const value = raw ?? DEFAULT_WORKSPACE_DIR
  if (!value.startsWith("/") || value.includes("\u0000")) {
    throw new Error("WORKSPACE_DIR must be an absolute path")
  }
  return value.replace(/\/+$/, "") || "/"
}

function readUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_DOCUMENTS_URL
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

export function loadDocumentsEnv(options: LoadDocumentsEnvOptions = {}): DocumentsEnv {
  const source = options.source ?? process.env
  const base = loadToolEnv({ source })
  const documentsToken = read(source, "DOCUMENTS_TOKEN")
  if (!documentsToken) {
    throw new Error("DOCUMENTS_TOKEN must be set for the documents tools")
  }
  return {
    ...base,
    python: readCommand(read(source, "OPENCHAT_PYTHON")),
    workspaceDir: readDirectory(read(source, "WORKSPACE_DIR")),
    documentsUrl: readUrl(read(source, "DOCUMENTS_URL")),
    documentsToken,
  }
}
