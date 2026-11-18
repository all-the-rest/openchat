/**
 * Artifact-surface configuration. The surface exists only when both halves are
 * set, so the rules live in one small module: `env.ts` stays under the
 * file-length gate and these rules can be tested without a process env.
 */

/** A short key still signs, so a typo would only weaken every URL silently. */
export const MIN_ARTIFACT_SIGNING_KEY_LENGTH = 32

/** Default artifact directory inside the workspace. */
export const ARTIFACT_DIR_NAME = ".openchat-artifacts"

export interface ArtifactEnvInput {
  /** Raw `ARTIFACT_HOST_URL`; trimmed, `undefined` when unset. */
  hostUrl?: string
  /** Raw `ARTIFACT_SIGNING_KEY`; exact characters, `undefined` when unset. */
  signingKey?: string
}

export interface ArtifactEnv {
  /** Public base URL of the artifact host; empty when the surface is hidden. */
  hostUrl: string
  /** Shared HMAC key; empty when the surface is hidden. */
  signingKey: string
}

/**
 * The artifact host base URL is optional: empty means the surface is not
 * configured and the UI hides it. A path is allowed (a deployment may mount
 * the host under a prefix), a trailing slash is dropped because the signed URL
 * appends `/a/<id>`. The value is never echoed.
 */
function readArtifactHostUrl(raw: string | undefined): string {
  if (!raw) return ""
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("ARTIFACT_HOST_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ARTIFACT_HOST_URL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("ARTIFACT_HOST_URL must not embed credentials")
  }
  if (url.search || url.hash) {
    throw new Error("ARTIFACT_HOST_URL must not carry a query or fragment")
  }
  const path = url.pathname.replace(/\/+$/, "")
  return path.length > 0 ? `${url.origin}${path}` : url.origin
}

/**
 * Validates the two halves together. One alone is a half-configured
 * deployment, not a boot failure: the server hides the surface and says why.
 */
export function loadArtifactEnv(
  input: ArtifactEnvInput,
  options: { production: boolean; warn(message: string): void },
): ArtifactEnv {
  const hostUrl = readArtifactHostUrl(input.hostUrl)
  const signingKey = input.signingKey ?? ""

  if (signingKey.length > 0 && signingKey.length < MIN_ARTIFACT_SIGNING_KEY_LENGTH) {
    // A short key still signs, so a typo would only weaken every URL silently.
    throw new Error(
      `ARTIFACT_SIGNING_KEY must be at least ${MIN_ARTIFACT_SIGNING_KEY_LENGTH} characters`,
    )
  }
  if (hostUrl && !signingKey) {
    options.warn("ARTIFACT_SIGNING_KEY is unset; the artifact surface stays hidden")
  }
  if (!hostUrl && signingKey) {
    options.warn("ARTIFACT_HOST_URL is unset; the artifact surface stays hidden")
  }
  if (hostUrl && options.production && new URL(hostUrl).protocol !== "https:") {
    throw new Error("ARTIFACT_HOST_URL must use https when NODE_ENV=production")
  }

  return { hostUrl, signingKey }
}
