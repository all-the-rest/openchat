import { resolve } from "node:path"

/**
 * Configuration of the artifact host. It is a read-only byte server on its own
 * origin: it knows the signing key and a directory, nothing else.
 */
export interface EnvConfig {
  HOST: string
  PORT: number
  /** Shared with the BFF; signs and verifies the `exp`/`sig` URL pair. */
  ARTIFACT_SIGNING_KEY: string
  /** Directory the BFF writes; this process reads it and never writes. */
  ARTIFACTS_DIR: string
  /** The chat origin allowed to frame an artifact document. */
  ARTIFACT_FRAME_ANCESTORS: string
}

export interface LoadEnvOptions {
  /** Defaults to `console.warn`; tests pass a no-op. */
  warn?: (message: string) => void
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 4100
/** The Vite dev server, which is where the chat app runs during development. */
const DEFAULT_FRAME_ANCESTORS = "http://localhost:5173"
const DEFAULT_ARTIFACTS_DIR = ".openchat-artifacts"
/** A key below this cannot carry enough entropy for a signature. */
const MIN_SIGNING_KEY_LENGTH = 32
/** A `;` would start a new CSP directive; a control byte would split a header. */
const UNSAFE_CSP_CHARACTERS = /[\u0000-\u001f\u007f;]/

function read(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Secrets keep their exact characters; only an empty value counts as unset. */
function readSecret(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined || value.trim().length === 0) return undefined
  return value
}

/** A TCP port; anything outside `1..65535` would fail later inside `listen`. */
function readPort(
  source: Record<string, string | undefined>,
  fallback: number,
  warn: (message: string) => void,
): number {
  const value = read(source, "PORT")
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    warn("PORT must be an integer between 1 and 65535; using the default")
    return fallback
  }
  return parsed
}

/**
 * Reads and validates the artifact host configuration. Warnings and refusals
 * name variables only; no value ever reaches a log.
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvConfig {
  const source = options.source ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(`[artifact-host] ${message}`))

  const signingKey = readSecret(source, "ARTIFACT_SIGNING_KEY")
  if (!signingKey) {
    // Unlike the BFF, this process cannot generate a key: it must match the
    // BFF's key, so an ephemeral one would only produce 403s.
    throw new Error("ARTIFACT_SIGNING_KEY must be set")
  }
  if (signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    throw new Error(
      `ARTIFACT_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters`,
    )
  }

  const frameAncestors = read(source, "ARTIFACT_FRAME_ANCESTORS") ?? DEFAULT_FRAME_ANCESTORS
  if (UNSAFE_CSP_CHARACTERS.test(frameAncestors)) {
    throw new Error("ARTIFACT_FRAME_ANCESTORS must be a CSP source list without ';' or control characters")
  }

  // A missing directory is legitimate: the BFF has not written an artifact
  // yet, and every document then answers 404. The path is resolved once so a
  // later working-directory change cannot move the store.
  const dir = read(source, "ARTIFACTS_DIR") ?? DEFAULT_ARTIFACTS_DIR

  return {
    HOST: read(source, "HOST") ?? DEFAULT_HOST,
    PORT: readPort(source, DEFAULT_PORT, warn),
    ARTIFACT_SIGNING_KEY: signingKey,
    ARTIFACTS_DIR: resolve(dir),
    ARTIFACT_FRAME_ANCESTORS: frameAncestors,
  }
}
