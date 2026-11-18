import type {
  ArchiveEntry,
  ArchiveRunner,
  ArchiveScriptValue,
  ArchiveTotals,
  ArchiveWrittenFile,
} from "./archive-types"
import { MAX_ARCHIVE_ENTRIES } from "./limits"
import type { RunnerOptions } from "./runner"
import { createScriptRunner } from "./runner"

/**
 * The process boundary for `archive_list` and `archive_extract`: the same
 * fixed-script runner, timeout, memory cap and error map as the document
 * tools, but the payload is a listing/extraction manifest instead of one
 * embedded file. Nothing from stderr or a traceback ever reaches the caller.
 */

const UNEXPECTED = "internal: the archive tool answered an unexpected body"
const MAX_WIRE_NAME = 4_000
const MAX_WIRE_PATH = 1_000
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value)
}

function readEntry(value: unknown): ArchiveEntry | null {
  if (!isRecord(value)) return null
  const { name, size, compressedSize, directory } = value
  if (!isText(name, MAX_WIRE_NAME)) return null
  if (!isCount(size) || !isCount(compressedSize) || typeof directory !== "boolean") return null
  return { name, size, compressedSize, directory }
}

function readTotals(value: unknown): ArchiveTotals | null {
  if (!isRecord(value)) return null
  const { entries, files, directories, uncompressedBytes, compressedBytes } = value
  if (!isCount(entries) || !isCount(files) || !isCount(directories)) return null
  if (!isCount(uncompressedBytes) || !isCount(compressedBytes)) return null
  return { entries, files, directories, uncompressedBytes, compressedBytes }
}

function readListing(payload: Record<string, unknown>): ArchiveScriptValue | null {
  if (!isCount(payload.bytes)) return null
  if (!Array.isArray(payload.entries) || payload.entries.length > MAX_ARCHIVE_ENTRIES) return null
  const entries: ArchiveEntry[] = []
  for (const item of payload.entries) {
    const entry = readEntry(item)
    if (!entry) return null
    entries.push(entry)
  }
  const totals = readTotals(payload.totals)
  if (!totals) return null
  return { kind: "listing", bytes: payload.bytes, entries, totals }
}

function readWrittenFile(value: unknown): ArchiveWrittenFile | null {
  if (!isRecord(value)) return null
  const { path, size } = value
  if (!isText(path, MAX_WIRE_PATH) || !isCount(size)) return null
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null
  return { path, size }
}

function readExtraction(payload: Record<string, unknown>): ArchiveScriptValue | null {
  if (!isText(payload.directory, 64)) return null
  if (!isCount(payload.bytes)) return null
  if (!Array.isArray(payload.files) || payload.files.length > MAX_ARCHIVE_ENTRIES) return null
  const files: ArchiveWrittenFile[] = []
  for (const item of payload.files) {
    const file = readWrittenFile(item)
    if (!file) return null
    files.push(file)
  }
  return { kind: "extraction", directory: payload.directory, files, bytes: payload.bytes }
}

export function createArchiveRunner(options: RunnerOptions = {}): ArchiveRunner {
  const run = createScriptRunner(options)
  return async (tool, input) => {
    const result = await run(tool, input)
    if (!result.ok) return result
    const value =
      tool === "archive_list" ? readListing(result.payload) : readExtraction(result.payload)
    if (!value) return { ok: false, error: UNEXPECTED }
    return { ok: true, value }
  }
}
