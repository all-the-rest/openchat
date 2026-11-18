/**
 * The MCP tool's configuration. The store directory is shared with the BFF;
 * the optional BFF URL and token only enable the "memory changed" notify. A
 * missing notify pair is not a startup failure: the write itself still works.
 */
const DEFAULT_WORKSPACE = "/workspace"

export interface MemoryToolEnv {
  /** Absolute directory holding facts.jsonl, INDEX.md and audit.jsonl. */
  dir: string
  /** Empty when no BFF notify is configured. */
  bffUrl: string
  /** Empty when no BFF notify is configured. Never logged. */
  token: string
}

function read(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key]?.trim()
  return value && value.length > 0 ? value : undefined
}

function normalizeUrl(raw: string | undefined): string {
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
  if (url.username || url.password) {
    throw new Error("OPENCHAT_BFF_URL must not embed credentials")
  }
  if (url.search || url.hash) {
    throw new Error("OPENCHAT_BFF_URL must not carry a query or fragment")
  }
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

export function loadMemoryToolEnv(
  source: Record<string, string | undefined> = process.env,
): MemoryToolEnv {
  const explicit = read(source, "MEMORY_DIR")
  const workspace = read(source, "WORKSPACE_DIR") ?? DEFAULT_WORKSPACE
  const dir = explicit ?? `${workspace.replace(/\/+$/, "")}/chats/.memory`
  const bffUrl = normalizeUrl(read(source, "OPENCHAT_BFF_URL"))
  const token = (source.ARTIFACT_INTERNAL_TOKEN ?? "").trim()
  if (!bffUrl || token.length === 0) return { dir, bffUrl: "", token: "" }
  return { dir, bffUrl, token }
}
