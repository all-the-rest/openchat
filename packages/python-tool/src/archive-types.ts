/**
 * Wire and result shapes for the two archive tools (issue #52). Kept free of
 * imports so the process boundary (`runner-archive.ts`) and the tool layer
 * (`archive.ts`) can share them without a cycle.
 */

/** One entry as `archive_list` reports it. */
export interface ArchiveEntry {
  name: string
  size: number
  compressedSize: number
  directory: boolean
}

export interface ArchiveTotals {
  entries: number
  files: number
  directories: number
  uncompressedBytes: number
  compressedBytes: number
}

/** Result of `archive_list`, with the chat's file name added by the tool. */
export interface ArchiveListing {
  kind: "listing"
  zip: string
  /** Size of the archive itself in bytes. */
  bytes: number
  entries: ArchiveEntry[]
  totals: ArchiveTotals
}

/** One extracted file, relative to the chat's `files/` directory. */
export interface ArchiveWrittenFile {
  path: string
  size: number
}

/** Result of `archive_extract` for one archive. */
export interface ArchiveExtraction {
  kind: "extraction"
  zip: string
  directory: string
  files: ArchiveWrittenFile[]
  /** Sum of the bytes actually written. */
  bytes: number
}

export type ArchiveValue = ArchiveListing | ArchiveExtraction

/** What the script answers; the chat file name is added by the tool layer. */
export type ArchiveScriptValue =
  | Omit<ArchiveListing, "zip">
  | Omit<ArchiveExtraction, "zip">

export type ArchiveOutcome =
  | { ok: true; value: ArchiveValue }
  | { ok: false; error: string }

export type ArchiveRun =
  | { ok: true; value: ArchiveScriptValue }
  | { ok: false; error: string }

export type ArchiveRunner = (
  tool: "archive_list" | "archive_extract",
  input: Record<string, unknown>,
) => Promise<ArchiveRun>
