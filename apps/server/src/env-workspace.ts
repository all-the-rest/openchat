import {
  CHAT_FILE_BODY_CEILING_BYTES,
  CHAT_FILE_MAX_BYTES,
  CHAT_QUOTA_PER_CHAT_BYTES,
  CHAT_QUOTA_TOTAL_BYTES,
} from "@openchat/contracts"

export interface WorkspaceEnv {
  /** Root of the agent workspace; chat files live under `chats/<sessionID>`. */
  directory: string
  quotaPerChatBytes: number
  quotaTotalBytes: number
  maxFileBytes: number
}

function read(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
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

/** `WORKSPACE_DIR` and the per-chat file quotas, in bytes. */
export function loadWorkspaceEnv(
  source: Record<string, string | undefined>,
  warn: (message: string) => void,
): WorkspaceEnv {
  let maxFileBytes = readNumber(
    source,
    "WORKSPACE_MAX_FILE_BYTES",
    CHAT_FILE_MAX_BYTES,
    warn,
  )
  if (maxFileBytes > CHAT_FILE_BODY_CEILING_BYTES) {
    warn("WORKSPACE_MAX_FILE_BYTES is above the 100 MiB ceiling; using the ceiling")
    maxFileBytes = CHAT_FILE_BODY_CEILING_BYTES
  }
  return {
    directory: read(source, "WORKSPACE_DIR") ?? process.cwd(),
    quotaPerChatBytes: readNumber(
      source,
      "WORKSPACE_QUOTA_PER_CHAT_BYTES",
      CHAT_QUOTA_PER_CHAT_BYTES,
      warn,
    ),
    quotaTotalBytes: readNumber(
      source,
      "WORKSPACE_QUOTA_TOTAL_BYTES",
      CHAT_QUOTA_TOTAL_BYTES,
      warn,
    ),
    maxFileBytes,
  }
}
