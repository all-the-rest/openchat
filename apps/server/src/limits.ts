/**
 * Generic request-body cap, applied before authentication and before parsing.
 * Every JSON route is small; `/api/transcribe` is the one exception and
 * enforces `DICTATION_MAX_BYTES` itself while it streams the audio.
 */
export const MAX_BODY_BYTES = 128 * 1024

export function isBodyTooLarge(buffer: ArrayBuffer): boolean {
  return buffer.byteLength > MAX_BODY_BYTES
}
