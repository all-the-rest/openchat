/**
 * Recording formats and human-readable limits (spec 04, dictation).
 *
 * Safari records `audio/mp4`, Chromium and Firefox `audio/webm;codecs=opus`.
 * The BFF only accepts the base MIME type, so the request drops the codec
 * parameter; the browser keeps it on the blob it produced.
 */
export const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"] as const

/** First MIME type the browser can record, or `null` when none is usable. */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null
  if (typeof MediaRecorder.isTypeSupported !== "function") return null
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMimeType(type: string): string {
  return type.split(";")[0]?.trim() || type
}

/** Recording clock in `m:ss`, matching the pill. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** Limit note for bytes, rounded for humans. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}
