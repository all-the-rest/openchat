/**
 * Media classification shared by the BFF (writes), the artifact host (serves)
 * and the browser (renders). Pure and synchronous: no filesystem, no request,
 * no client-supplied MIME. The bytes decide the type, never a header, a file
 * name or an `Accept` header.
 */

/** What the UI can do with an artifact's bytes. */
export type ArtifactKind = "html" | "image" | "pdf" | "file"

/** The four image types the image card and the gallery accept. */
export const ARTIFACT_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const

export type ArtifactImageMime = (typeof ARTIFACT_IMAGE_MIMES)[number]

/** PDFs are previewed in the sandboxed viewer, never injected as HTML. */
export const ARTIFACT_PDF_MIME = "application/pdf"
/** Unknown binary bytes keep a generic card. */
export const ARTIFACT_FILE_MIME = "application/octet-stream"
/** HTML documents are the existing sandboxed documents, not inline images. */
export const ARTIFACT_HTML_MIME = "text/html; charset=utf-8"

const PNG: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG: readonly number[] = [0xff, 0xd8, 0xff]
const PDF = "%PDF-"
const HTML_START = /^<(?:!doctype\s+html|html)\b/i
const SAMPLE_BYTES = 256

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/** True only for one of the four supported image MIME types. */
export function isArtifactImageMime(value: string): value is ArtifactImageMime {
  return (ARTIFACT_IMAGE_MIMES as readonly string[]).includes(value)
}

/** The display kind of a stored MIME type; an absent MIME means legacy HTML. */
export function artifactKind(mime: string | undefined): ArtifactKind {
  if (!mime) return "html"
  if (mime === ARTIFACT_HTML_MIME || mime === "text/html") return "html"
  if (mime === ARTIFACT_PDF_MIME) return "pdf"
  if (isArtifactImageMime(mime)) return "image"
  return "file"
}

/** Extension for a download's suggested name, derived from the stored MIME. */
export function artifactExtension(mime: string | undefined): string {
  const kind = artifactKind(mime)
  if (kind === "html") return ".html"
  if (kind === "pdf") return ".pdf"
  if (!mime) return ".bin"
  const subtype = mime.slice(mime.indexOf("/") + 1)
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`
}

/**
 * Sniffs the leading bytes. HTML documents are recognised so an HTML body can
 * never be served as a generic binary; everything else is an image, a PDF or
 * opaque bytes. `nosniff` on the response is the second half of this guard.
 */
export function artifactMime(bytes: Uint8Array): string {
  if (startsWith(bytes, PNG)) return "image/png"
  if (startsWith(bytes, JPEG)) return "image/jpeg"
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif"
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp"
  if (asciiAt(bytes, 0, PDF)) return ARTIFACT_PDF_MIME
  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, SAMPLE_BYTES))
    .replace(/^\uFEFF/, "")
    .trimStart()
  if (HTML_START.test(sample)) return ARTIFACT_HTML_MIME
  return ARTIFACT_FILE_MIME
}
