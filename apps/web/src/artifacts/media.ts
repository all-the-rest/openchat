import type { ArtifactResponse } from "@openchat/contracts"
import { isArtifactImageMime, ARTIFACT_PDF_MIME } from "@openchat/contracts/artifacts/mime"

/** A fresh signed URL is always absolute http(s) with no embedded credentials. */
const SIGNED_PATH = /\/a\/([0-9a-f]{64})$/
const EXPIRY = /^[0-9]{1,15}$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/

/**
 * The browser never assembles an artifact URL. This is only a trust check on a
 * URL the BFF returned: an image `src` must be a signed URL for the same id,
 * optionally on a caller-supplied artifact origin. A data:, relative or
 * third-party URL fails and the card downgrades to the generic shape.
 */
export function isTrustedArtifactUrl(
  url: string,
  id: string,
  artifactOrigin?: string,
): boolean {
  if (!url || !id) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  if (parsed.username || parsed.password) return false
  if (!isArtifactId(id)) return false
  if (artifactOrigin) {
    try {
      if (parsed.origin !== new URL(artifactOrigin).origin) return false
    } catch {
      return false
    }
  }
  const path = parsed.pathname.replace(/\/+$/, "")
  const match = SIGNED_PATH.exec(path)
  if (!match || match[1] !== id) return false
  return (
    EXPIRY.test(parsed.searchParams.get("exp") ?? "") &&
    SIGNATURE.test(parsed.searchParams.get("sig") ?? "")
  )
}

function isArtifactId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** Only the four sniffed image types may become an `<img>`. */
export function isImageArtifact(
  artifact: Pick<ArtifactResponse, "id" | "url" | "mime">,
  artifactOrigin?: string,
): boolean {
  if (!artifact.mime || !isArtifactImageMime(artifact.mime)) return false
  return isTrustedArtifactUrl(artifact.url, artifact.id, artifactOrigin)
}

/** PDFs use the sandboxed viewer; their bytes are never injected as HTML. */
export function isPdfArtifact(artifact: Pick<ArtifactResponse, "mime">): boolean {
  return artifact.mime === ARTIFACT_PDF_MIME
}
