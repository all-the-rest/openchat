/**
 * Artifact identity and on-disk layout, shared by the BFF (writes), the
 * artifact host (reads) and the signer (validates before hashing).
 *
 * The id is the SHA-256 of the exact document bytes, lower-case hex. One
 * pattern, one layout: a second copy in either app is how an id check and a
 * directory name drift apart.
 */

/**
 * 64 lower-case hex characters. Checked **before** any path or buffer is
 * built, so `..`, an absolute path or a NUL byte never reaches the filesystem.
 */
const ID_PATTERN = /^[0-9a-f]{64}$/

/** True for a 64-character lower-case SHA-256 hex digest. */
export function isArtifactId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/**
 * One directory per artifact:
 *
 * ```
 * <dir>/<id>/index.html   the stored document
 * <dir>/<id>/meta.json    { title, bytes, createdAt }
 * ```
 */
export const ARTIFACT_DOCUMENT_FILE = "index.html"

/** Sidecar metadata written by the BFF; never read by the byte host. */
export const ARTIFACT_META_FILE = "meta.json"
