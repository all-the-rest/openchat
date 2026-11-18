import type { ArchiveEntry, ArchiveValue } from "./archive-types"
import type { ToolSuccess } from "./tool"

/**
 * Text results for the MCP surface. Kept out of `index.ts` so the formatter is
 * unit-testable without starting the stdio server. Every name is bounded: an
 * archive may list 500 entries and a single name may be long, so the listing
 * truncates names and the caller still gets the counts.
 */

const MAX_DISPLAY_NAME = 120

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function displayName(name: string): string {
  const characters = [...name]
  return characters.length > MAX_DISPLAY_NAME
    ? `${characters.slice(0, MAX_DISPLAY_NAME).join("")}…`
    : name
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function entryLine(entry: ArchiveEntry): string {
  const suffix = entry.directory ? " (directory)" : ""
  return `${displayName(entry.name)} — ${size(entry.size)}${suffix}`
}

export function formatToolSuccess(value: ToolSuccess, read: boolean): string {
  const verb = read ? "Read" : "Wrote"
  const head = `${verb} "${value.filename}" (artifact ${value.artifactID}, ${value.fileBytes} bytes).`
  const files = value.files === undefined ? "" : `\nChat files: ${value.files.join(", ")}.`
  const preview = value.preview === undefined ? "" : `\n\n${value.preview}`
  return `${head}${files}${preview}`
}

export function formatArchive(value: ArchiveValue): string {
  if (value.kind === "listing") {
    const totals = value.totals
    const head =
      `Archive "${value.zip}" (${size(value.bytes)}): ${plural(totals.entries, "entry", "entries")} — ` +
      `${plural(totals.files, "file", "files")}, ${plural(totals.directories, "directory", "directories")}, ` +
      `${size(totals.uncompressedBytes)} uncompressed, ${size(totals.compressedBytes)} compressed.`
    if (value.entries.length === 0) return `${head}\nThe archive is empty.`
    return `${head}\n${value.entries.map(entryLine).join("\n")}`
  }

  const head =
    `Extracted "${value.zip}" into files/${value.directory}/ — ` +
    `${plural(value.files.length, "file", "files")}, ${size(value.bytes)}.`
  if (value.files.length === 0) return `${head}\nThe archive had no files.`
  return `${head}\n${value.files.map((file) => `${displayName(file.path)} — ${size(file.size)}`).join("\n")}`
}
