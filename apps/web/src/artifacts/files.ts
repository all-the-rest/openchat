import type { Locale } from "../i18n"
import { artifactExtension } from "@openchat/contracts/artifacts/mime"

/** Legacy documents keep the HTML extension; media uses its sniffed one. */
export const ARTIFACT_EXTENSION = ".html"

/**
 * A signed URL is refreshed before it expires. One minute of headroom covers a
 * slow first paint on a link minted at the edge of its lifetime.
 */
export const ARTIFACT_REFRESH_MARGIN_MS = 60_000

const UNSAFE_FILENAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/g
const FALLBACK_FILENAME = "artifact"
const MAX_FILENAME_BASE = 120

/**
 * The title is already sanitised by the store, but a download name is a
 * filesystem path on the owner's machine: separators, control characters and a
 * leading dot never survive, and the extension is added exactly once.
 */
export function artifactFilename(title: string, mime?: string): string {
  const extension = mime ? artifactExtension(mime) : ARTIFACT_EXTENSION
  const flattened = title
    .replace(UNSAFE_FILENAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.]+/, "")
  const base = [...flattened].slice(0, MAX_FILENAME_BASE).join("").trim()
  const safe = base.length > 0 ? base : FALLBACK_FILENAME
  return safe.toLowerCase().endsWith(extension) ? safe : `${safe}${extension}`
}

/** Whether a URL is close enough to expiry that a fresh read is worthwhile. */
export function needsFreshURL(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires)) return true
  return expires - now <= ARTIFACT_REFRESH_MARGIN_MS
}

/** Human size for the list; the unit comes from the locale, not a literal. */
export function formatBytes(bytes: number, locale: Locale): string {
  const value = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  if (value < 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    }).format(value)
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "kilobyte",
    unitDisplay: "narrow",
    maximumFractionDigits: 1,
  }).format(value / 1024)
}

/** Locale-aware write time; an unparseable value is shown unchanged. */
export function formatArtifactDate(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

/**
 * Saves a downloaded blob under `filename`. The object URL is revoked on the
 * next task so the browser has started the download but the blob does not
 * outlive the click.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  link.style.display = "none"
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
