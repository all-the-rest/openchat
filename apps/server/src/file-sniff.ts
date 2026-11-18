/**
 * Magic-byte sniffing for the one route that accepts a raw file body.
 *
 * Pure and synchronous: no filesystem, no request, no client-supplied MIME.
 * A file is accepted only when its leading bytes identify a type on the
 * allowlist *and* its extension agrees with that type. The returned MIME is
 * the sniffed one, so a renamed file cannot borrow another type's MIME.
 */
import { extname } from "node:path"

export type AllowedFileKind =
  | "text"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "zip"

export interface SniffedFile {
  kind: AllowedFileKind
  mime: string
}

const MIME: Record<AllowedFileKind, string> = {
  text: "text/plain; charset=utf-8",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
}

/** Only these extensions may be uploaded; every other one is unsupported. */
const EXTENSION_KIND: Record<string, AllowedFileKind> = {
  ".txt": "text",
  ".md": "text",
  ".csv": "text",
  ".json": "text",
  ".log": "text",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".zip": "zip",
}

const TEXT_SAMPLE_BYTES = 8 * 1024
const MARKUP_SAMPLE_CHARS = 1024

const PNG: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG: readonly number[] = [0xff, 0xd8, 0xff]
const ZIP: readonly number[] = [0x50, 0x4b, 0x03, 0x04]

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

function containsAscii(bytes: Uint8Array, value: string): boolean {
  if (value.length === 0) return false
  // The Office marker sits in ZIP entry names near the central directory, so
  // the whole (already bounded) body is searched, not just the header sample.
  for (let index = 0; index <= bytes.byteLength - value.length; index += 1) {
    if (asciiAt(bytes, index, value)) return true
  }
  return false
}

/** HTML/SVG is never plain text here: no preview without the artifact sandbox. */
function looksLikeMarkup(sample: string): boolean {
  const head = sample.replace(/^\uFEFF/, "").trimStart().slice(0, MARKUP_SAMPLE_CHARS)
  if (!head.startsWith("<")) return false
  if (/^<(?:!doctype\s+html|html|svg|script|iframe|body|head)\b/i.test(head)) return true
  return /^<\?xml[\s\S]{0,512}?<svg\b/i.test(head)
}

function hasNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, TEXT_SAMPLE_BYTES)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

function zipKind(bytes: Uint8Array): AllowedFileKind {
  if (containsAscii(bytes, "word/")) return "docx"
  if (containsAscii(bytes, "xl/")) return "xlsx"
  if (containsAscii(bytes, "ppt/")) return "pptx"
  return "zip"
}

/** `null` means the bytes are empty, markup, binary or otherwise not allowed. */
export function sniffFile(bytes: Uint8Array): SniffedFile | null {
  if (bytes.byteLength === 0) return null
  if (startsWith(bytes, PNG)) return { kind: "png", mime: MIME.png }
  if (startsWith(bytes, JPEG)) return { kind: "jpeg", mime: MIME.jpeg }
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return { kind: "gif", mime: MIME.gif }
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return { kind: "webp", mime: MIME.webp }
  }
  if (asciiAt(bytes, 0, "%PDF-")) return { kind: "pdf", mime: MIME.pdf }
  if (startsWith(bytes, ZIP)) {
    const kind = zipKind(bytes)
    return { kind, mime: MIME[kind] }
  }
  if (hasNul(bytes)) return null
  const sample = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, TEXT_SAMPLE_BYTES),
  )
  if (looksLikeMarkup(sample)) return null
  return { kind: "text", mime: MIME.text }
}

/** True when the file name's extension belongs to the sniffed type. */
export function extensionMatches(name: string, kind: AllowedFileKind): boolean {
  return EXTENSION_KIND[extname(name).toLowerCase()] === kind
}
