import { ARTIFACT_MAX_BYTES } from "@openchat/contracts"

/**
 * Generic request-body cap, applied before authentication and before parsing.
 * Every JSON route is small; `/api/transcribe` is the one exception and
 * enforces `DICTATION_MAX_BYTES` itself while it streams the audio.
 */
export const MAX_BODY_BYTES = 128 * 1024

/**
 * `POST /api/artifacts` carries a document of up to 1 MiB inside a JSON
 * string, so its envelope needs room above `MAX_BODY_BYTES`. JSON escaping can
 * double the size when the document is full of quotes or control characters;
 * 2 MiB plus a title leaves enough headroom for the declared cap.
 */
export const ARTIFACT_BODY_MAX_BYTES = 2 * ARTIFACT_MAX_BYTES + 4 * 1024

export function isBodyTooLarge(buffer: ArrayBuffer, maxBytes = MAX_BODY_BYTES): boolean {
  return buffer.byteLength > maxBytes
}
