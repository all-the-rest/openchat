/**
 * Workspace file quotas. Kept out of `env.ts` so the parsing rules and their
 * defaults can be tested without a process env and `env.ts` stays under the
 * file-length gate.
 *
 * Defaults, and why: 100 MiB per chat fits a filled Office template, a few
 * PDFs and generated images without inviting a chat to hoard a disk; 1 GiB
 * across the workspace bounds a single volume while leaving room for ten
 * full chats; 25 MiB per file matches the dictation cap and covers every PDF
 * or DOCX a chat realistically produces. The per-file ceiling is 100 MiB so a
 * misconfigured value cannot turn one upload into an out-of-memory event.
 */
import {
  CHAT_FILE_BODY_CEILING_BYTES,
  CHAT_FILE_MAX_BYTES,
  CHAT_QUOTA_PER_CHAT_BYTES,
  CHAT_QUOTA_TOTAL_BYTES,
} from "@openchat/contracts"

export interface WorkspaceFileEnv {
  /** Per-chat quota in bytes; a write above it is rejected with 413. */
  WORKSPACE_QUOTA_PER_CHAT_BYTES: number
  /** Workspace-wide quota across every chat directory. */
  WORKSPACE_QUOTA_TOTAL_BYTES: number
  /** Largest single chat file; also caps the upload request body. */
  WORKSPACE_MAX_FILE_BYTES: number
}

function readPositiveInteger(
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
  warn: (message: string) => void,
): number {
  const raw = source[key]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warn(`${key} must be a positive integer; using the default`)
    return fallback
  }
  return parsed
}

/**
 * Reads the three quota variables. Only `WORKSPACE_MAX_FILE_BYTES` has a
 * ceiling; the quotas are operator policy and may be set as high as the disk
 * allows. A per-chat quota above the workspace total is allowed but warned
 * about, because the total then rejects every write that fills one chat.
 */
export function loadWorkspaceEnv(
  source: Record<string, string | undefined>,
  warn: (message: string) => void,
): WorkspaceFileEnv {
  const perChat = readPositiveInteger(
    source,
    "WORKSPACE_QUOTA_PER_CHAT_BYTES",
    CHAT_QUOTA_PER_CHAT_BYTES,
    warn,
  )
  const total = readPositiveInteger(
    source,
    "WORKSPACE_QUOTA_TOTAL_BYTES",
    CHAT_QUOTA_TOTAL_BYTES,
    warn,
  )
  if (perChat > total) {
    warn(
      "WORKSPACE_QUOTA_PER_CHAT_BYTES is above WORKSPACE_QUOTA_TOTAL_BYTES; " +
        "the workspace quota will reject writes first",
    )
  }

  let maxFile = readPositiveInteger(
    source,
    "WORKSPACE_MAX_FILE_BYTES",
    CHAT_FILE_MAX_BYTES,
    warn,
  )
  if (maxFile > CHAT_FILE_BODY_CEILING_BYTES) {
    warn("WORKSPACE_MAX_FILE_BYTES is above the 100 MiB ceiling; using the ceiling")
    maxFile = CHAT_FILE_BODY_CEILING_BYTES
  }

  return {
    WORKSPACE_QUOTA_PER_CHAT_BYTES: perChat,
    WORKSPACE_QUOTA_TOTAL_BYTES: total,
    WORKSPACE_MAX_FILE_BYTES: maxFile,
  }
}
