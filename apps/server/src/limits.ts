/**
 * Request bodies are capped before authentication and before parsing. The
 * limit applies to every route; the BFF only accepts small JSON commands.
 */
export const MAX_BODY_BYTES = 128 * 1024

export function isBodyTooLarge(buffer: ArrayBuffer): boolean {
  return buffer.byteLength > MAX_BODY_BYTES
}
