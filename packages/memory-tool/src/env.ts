/**
 * Tool-side configuration. The memory directory is shared with the BFF; the
 * notification values are optional and only enable the post-write refresh. No
 * value is ever logged, and a bad BFF URL fails the boot rather than silently
 * talking to a different host.
 */
import { defaultMemoryDir } from "@openchat/memory-store"

export interface MemoryToolEnv {
  /** Directory holding facts.jsonl, INDEX.md and audit.jsonl. */
  dir: string
  /** BFF base URL; empty when the refresh notification is not configured. */
  bffUrl: string
  /** Shared internal bearer token; empty when notifications are disabled. */
  token: string
}

export interface LoadEnvOptions {
  source?: Record<string, string | undefined>
  workspaceDir?: string
}

function read(source: Record<string, string | undefined>, key: string): string {
  const value = source[key]
  return value === undefined ? "" : value.trim()
}

function readBffUrl(raw: string): string {
  if (!raw) return ""
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("OPENCHAT_BFF_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCHAT_BFF_URL must use http or https")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OPENCHAT_BFF_URL must not embed credentials or a query")
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** Refusals name the variable only, never a value. */
export function loadMemoryToolEnv(options: LoadEnvOptions = {}): MemoryToolEnv {
  const source = options.source ?? process.env
  const dir = read(source, "MEMORY_DIR") || defaultMemoryDir(options.workspaceDir ?? "/workspace")
  const bffUrl = readBffUrl(read(source, "OPENCHAT_BFF_URL"))
  const token = source.ARTIFACT_INTERNAL_TOKEN?.trim() ?? ""
  return { dir, bffUrl, token }
}
