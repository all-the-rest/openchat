/**
 * Artifacts: one self-contained HTML document, stored by content and served
 * from a separate origin over a signed, short-lived URL. See
 * `docs/architecture/04-artifact-sandbox.md` and
 * `docs/implementation/09-artifacts.md`.
 */

/** Largest stored document: 1 MiB. The route caps the JSON body above it. */
export const ARTIFACT_MAX_BYTES = 1_048_576

/** Longest stored title, after trimming and control-character removal. */
export const ARTIFACT_TITLE_MAX = 120

/** Largest `code` input of `openchat_app_write`: one JSX module, 64 KiB. */
export const ARTIFACT_CODE_MAX_BYTES = 65_536

/** Largest `css` input of `openchat_app_write`: 32 KiB, inlined into one style. */
export const ARTIFACT_CSS_MAX_BYTES = 32_768

/**
 * Signed-URL lifetime: 15 minutes, the ceiling from the sandbox design. A URL
 * is minted fresh on every read, so a client never holds a stale one.
 */
export const ARTIFACT_URL_TTL_SECONDS = 900

/** Stored metadata of one artifact. The id is the SHA-256 of the bytes. */
export interface ArtifactMeta {
  /** 64 lowercase hex characters: the SHA-256 of the stored document. */
  id: string
  /** Plain text, already sanitised and capped at `ARTIFACT_TITLE_MAX`. */
  title: string
  /** Size of the stored document in bytes. */
  bytes: number
  /** ISO 8601 timestamp of the first write; a repeat write keeps it. */
  createdAt: string
}

/**
 * Result of `POST /api/artifacts` and of both read routes: the stored metadata
 * plus a freshly minted URL.
 */
export interface ArtifactResponse extends ArtifactMeta {
  /** Absolute signed URL on the artifact host. */
  url: string
  /** ISO 8601 expiry of `url`; request a fresh one afterwards. */
  expiresAt: string
}

/** Body of `POST /api/artifacts`: one complete HTML document. */
export interface ArtifactCreateRequest {
  /** Plain text; trimmed, control characters replaced, capped at 120. */
  title: string
  /** The stored bytes; must start with `<!doctype html` or `<html`. */
  html: string
}

/**
 * Body of `POST /internal/artifacts`, the bearer-authenticated route the MCP
 * tool posts to. The tool has already validated and compiled the document, so
 * the route applies the same store validation and nothing else.
 */
export type ArtifactInternalCreateRequest = ArtifactCreateRequest

/**
 * Receipt of `POST /internal/artifacts` and of `openchat_app_write`. It carries
 * no URL: the tool never re-emits the document or hands a signed link to the
 * model.
 */
export interface ArtifactWriteReceipt {
  /** 64 lowercase hex characters: the SHA-256 of the stored document. */
  artifactID: string
  /** The stored title, after store sanitisation. */
  title: string
  /** Size of the stored document in bytes. */
  bytes: number
}

/**
 * Artifact surface availability, delivered with `/api/info` so the client can
 * hide the artifact entry without a second request.
 */
export interface ArtifactsSurfaceInfo {
  /** True only when a host URL and a signing key are both configured. */
  available: boolean
}
