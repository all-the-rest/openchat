import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import { ARTIFACT_MAX_BYTES, ARTIFACT_TITLE_MAX } from "@openchat/contracts"
import type { ArtifactMeta } from "@openchat/contracts"
import {
  ARTIFACT_DOCUMENT_FILE,
  ARTIFACT_MEDIA_FILE,
  ARTIFACT_META_FILE,
  isArtifactId,
} from "@openchat/contracts/artifacts/id"
import { ARTIFACT_HTML_MIME, artifactMime } from "@openchat/contracts/artifacts/mime"

/** Newest-first list length; the store never returns more than this. */
export const ARTIFACT_LIST_LIMIT = 100

/** Leading document marker; the HTML is stored as-is, so this is all we need. */
const DOCUMENT_START = /^<(?:!doctype html|html)/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const FALLBACK_TITLE = "Untitled"

export interface ArtifactStoreOptions {
  /** Root directory; created on the first write, never at boot. */
  dir: string
  /** Injected clock for `createdAt`; tests advance it. */
  now?: () => number
}

/** Untrusted input: the store validates and sanitises it. */
export interface ArtifactDraft {
  title: unknown
  html: unknown
}

/** Untrusted binary input: base64 text and a plain-text title. */
export interface ArtifactMediaDraft {
  title: unknown
  /** Unpadded or padded standard base64 of the exact stored bytes. */
  data: unknown
}

export type ArtifactCreateResult =
  | { ok: true; artifact: ArtifactMeta }
  | { ok: false; reason: string }

interface StoredMeta {
  title: string
  bytes: number
  createdAt: string
  mime?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Replaces control characters (a newline or a NUL in a title would end up in a
 * header, a log or a DOM node) and caps the result by code points, so a title
 * cannot be cut mid surrogate pair.
 */
export function cleanTitle(title: string): string {
  const flattened = title.replace(CONTROL_CHARACTERS, " ").trim()
  const capped = [...flattened].slice(0, ARTIFACT_TITLE_MAX).join("").trim()
  return capped.length > 0 ? capped : FALLBACK_TITLE
}

/**
 * Writes through a sibling temporary name and renames it into place. The
 * rename is atomic on one filesystem, so a crash leaves a `.tmp` file at worst
 * and never a half document under the real name. No `fsync`: this is a
 * single-user read-mostly store, not a database.
 */
async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

/** Reads `meta.json`; a missing, unreadable or malformed file is "no meta". */
async function readMeta(path: string): Promise<StoredMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed)) return null
    const { title, bytes, createdAt } = parsed
    if (typeof title !== "string") return null
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null
    if (typeof createdAt !== "string") return null
    const mime = "mime" in parsed && typeof parsed.mime === "string" ? parsed.mime : undefined
    return { title, bytes, createdAt, mime }
  } catch {
    return null
  }
}

type DraftValidation =
  | { ok: true; title: string; html: string }
  | { ok: false; reason: string }

type MediaValidation =
  | { ok: true; title: string; bytes: Buffer; mime: string }
  | { ok: false; reason: string }

/** Standard base64 only; whitespace and URL-safe characters are refused. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
/** Four base64 characters carry at most three bytes. */
const BASE64_MAX_CHARS = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4

/**
 * The reasons are fixed short phrases: the route returns one as the error
 * message, so no part of the rejected document can reach the client or a log.
 */
function validateDraft(draft: ArtifactDraft): DraftValidation {
  const { title, html } = draft
  if (typeof title !== "string") return { ok: false, reason: "title must be a string" }
  if (typeof html !== "string") return { ok: false, reason: "html must be a string" }
  if (html.trim().length === 0) return { ok: false, reason: "html must not be empty" }
  if (Buffer.byteLength(html, "utf8") > ARTIFACT_MAX_BYTES) {
    return { ok: false, reason: `html must not exceed ${ARTIFACT_MAX_BYTES} bytes` }
  }
  // Checking the size first keeps the lower-cased copy of a huge string cheap
  // to reject; the copy is bounded by the check above.
  if (!DOCUMENT_START.test(html.trim().toLowerCase())) {
    return { ok: false, reason: "html must start with <!doctype html or <html" }
  }
  return { ok: true, title: cleanTitle(title), html }
}

/**
 * Binary bytes arrive as base64 in the JSON body, so the exact wire bytes are
 * checked before decoding: a non-canonical encoding could otherwise turn one
 * id into two different byte sequences. The sniffed MIME is stored alongside
 * the metadata and is the only source of the served Content-Type.
 */
function validateMediaDraft(draft: ArtifactMediaDraft): MediaValidation {
  if (typeof draft.title !== "string") return { ok: false, reason: "title must be a string" }
  if (typeof draft.data !== "string" || draft.data.length === 0) {
    return { ok: false, reason: "data must be a base64 string" }
  }
  if (draft.data.length > BASE64_MAX_CHARS) {
    return { ok: false, reason: `data must not exceed ${ARTIFACT_MAX_BYTES} bytes` }
  }
  if (!BASE64_PATTERN.test(draft.data)) {
    return { ok: false, reason: "data must be a base64 string" }
  }
  const bytes = Buffer.from(draft.data, "base64")
  if (bytes.byteLength === 0 || bytes.byteLength > ARTIFACT_MAX_BYTES) {
    return { ok: false, reason: `data must not exceed ${ARTIFACT_MAX_BYTES} bytes` }
  }
  if (bytes.toString("base64") !== draft.data) {
    return { ok: false, reason: "data must be canonical base64" }
  }
  const mime = artifactMime(bytes)
  if (mime === ARTIFACT_HTML_MIME) {
    return { ok: false, reason: "HTML must be written with the html field" }
  }
  return { ok: true, title: cleanTitle(draft.title), bytes, mime }
}

/**
 * Content-addressed artifact storage. The id is the SHA-256 of the exact
 * UTF-8 bytes, so identical documents share one directory and a repeat write
 * keeps the first title: `meta.json` is only written when it does not exist.
 */
export class ArtifactStore {
  private readonly dir: string
  private readonly now: () => number

  constructor(options: ArtifactStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? (() => Date.now())
  }

  async create(draft: ArtifactDraft): Promise<ArtifactCreateResult> {
    const validation = validateDraft(draft)
    if (!validation.ok) return validation
    const bytes = Buffer.from(validation.html, "utf8")
    return this.storeBytes(bytes, validation.title, ARTIFACT_HTML_MIME, ARTIFACT_DOCUMENT_FILE)
  }

  /**
   * Stores a sniffed image, PDF or opaque binary artifact. HTML is refused:
   * one writer owns documents, so there is no path that can turn binary bytes
   * into an HTML document on this origin.
   */
  async createMedia(draft: ArtifactMediaDraft): Promise<ArtifactCreateResult> {
    const validation = validateMediaDraft(draft)
    if (!validation.ok) return validation
    return this.storeBytes(validation.bytes, validation.title, validation.mime, ARTIFACT_MEDIA_FILE)
  }

  private async storeBytes(
    bytes: Buffer,
    title: string,
    mime: string,
    file: string,
  ): Promise<ArtifactCreateResult> {
    const id = createHash("sha256").update(bytes).digest("hex")
    // A repeat write of the same bytes is a read: the stored title and
    // creation time win, no matter who writes second.
    const existing = await this.get(id)
    if (existing) return { ok: true, artifact: existing }

    const directory = join(this.dir, id)
    await mkdir(directory, { recursive: true })
    await writeAtomic(join(directory, file), bytes)

    // Re-check before writing metadata: two writers racing on one id both
    // reach this point, and only the first `meta.json` may survive.
    const raced = await this.get(id)
    if (raced) return { ok: true, artifact: raced }

    const meta: StoredMeta = {
      title,
      bytes: bytes.byteLength,
      createdAt: new Date(this.now()).toISOString(),
      mime,
    }
    await writeAtomic(
      join(directory, ARTIFACT_META_FILE),
      Buffer.from(JSON.stringify(meta), "utf8"),
    )
    return { ok: true, artifact: { id, ...meta } }
  }

  /** `null` for an unknown id, a bad shape or an unreadable directory. */
  async get(id: string): Promise<ArtifactMeta | null> {
    if (!isArtifactId(id)) return null
    const stored = await readMeta(join(this.dir, id, ARTIFACT_META_FILE))
    if (!stored) return null
    return { id, ...stored }
  }

  /**
   * Exact bytes plus their MIME for the BFF's download route and the byte host.
   * The media name is tried first; a legacy directory only has `index.html`.
   * A directory without a readable `meta.json` is an unknown id.
   */
  async readMedia(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const meta = await this.get(id)
    if (!meta) return null
    for (const file of [ARTIFACT_MEDIA_FILE, ARTIFACT_DOCUMENT_FILE]) {
      try {
        const bytes = await readFile(join(this.dir, id, file))
        return { bytes, mime: meta.mime ?? artifactMime(bytes) }
      } catch {
        // Try the other layout before giving up.
      }
    }
    return null
  }

  /** The exact stored bytes; kept for the download route's callers. */
  async read(id: string): Promise<Buffer | null> {
    const found = await this.readMedia(id)
    return found?.bytes ?? null
  }

  /**
   * Newest first by `createdAt`. ISO 8601 UTC strings of equal width sort
   * lexicographically, so no date parsing is needed; the id breaks a tie.
   */
  async list(options: { limit?: number } = {}): Promise<ArtifactMeta[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch {
      // No directory yet: an empty surface, not an error.
      return []
    }
    const ids = entries
      .filter((entry) => entry.isDirectory() && isArtifactId(entry.name))
      .map((entry) => entry.name)
    const items = await Promise.all(ids.map((id) => this.get(id)))
    const found = items.filter((item): item is ArtifactMeta => item !== null)
    found.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.id.localeCompare(right.id)
    })
    const requested = options.limit ?? ARTIFACT_LIST_LIMIT
    return found.slice(0, Math.max(1, Math.min(requested, ARTIFACT_LIST_LIMIT)))
  }
}
