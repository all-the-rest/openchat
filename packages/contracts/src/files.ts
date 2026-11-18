/**
 * Per-chat working files. The BFF keeps one directory per session plus an
 * index with the metadata a list needs; these wire types mirror that index
 * without exposing filesystem paths.
 */

/** Where a chat file came from. Both kinds live in the same directory. */
export type ChatFileOrigin = "upload" | "agent"

/** One file shown in a chat's file list. */
export interface ChatFileInfo {
  /** Stored name: one path segment, already normalised and collision-free. */
  name: string
  /** Name shown to the owner; equal to `name` unless a collision added a suffix. */
  displayName: string
  size: number
  /** Modification time as an ISO 8601 UTC string. */
  mtime: string
  mime: string
  origin: ChatFileOrigin
  /** Lowercase hex SHA-256 of the exact stored bytes. */
  sha256: string
}

/** Fill level of the chat's directory and of the whole workspace. */
export interface ChatFileQuota {
  usedBytes: number
  quotaBytes: number
  totalUsedBytes: number
  totalQuotaBytes: number
}

/** Result of `GET /api/sessions/:id/files`. */
export interface ChatFilesResponse {
  files: ChatFileInfo[]
  quota: ChatFileQuota
}

/** Longest accepted file name, in characters. */
export const CHAT_FILE_NAME_MAX = 200

/** Largest single file by default; `WORKSPACE_MAX_FILE_BYTES` can lower it. */
export const CHAT_FILE_MAX_BYTES = 26_214_400

/** Default per-chat quota: 100 MiB. */
export const CHAT_QUOTA_PER_CHAT_BYTES = 104_857_600

/** Default workspace-wide quota: 1 GiB. */
export const CHAT_QUOTA_TOTAL_BYTES = 1_073_741_824

/** Hard ceiling for a configured upload body, matching the dictation cap. */
export const CHAT_FILE_BODY_CEILING_BYTES = 104_857_600
