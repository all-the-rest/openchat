/**
 * Memory-surface configuration. The memory surface is always present: it has a
 * store directory and an internal bearer token. Keeping the rules here lets
 * `env.ts` stay under the file-length gate and makes them testable without a
 * process env.
 */
import { randomBytes } from "node:crypto"
import { isAbsolute, normalize } from "node:path"

/** Default memory directory inside the workspace. */
export const DEFAULT_MEMORY_DATA_DIR = "/workspace/.memory"

/** A short bearer token is guessable by anything that can reach the route. */
export const MIN_MEMORY_INTERNAL_TOKEN_LENGTH = 32

export interface MemoryEnvInput {
  /** Raw `MEMORY_DATA_DIR`; trimmed, `undefined` when unset. */
  dataDir?: string
  /** Raw `MEMORY_INTERNAL_TOKEN`; exact characters, `undefined` when unset. */
  internalToken?: string
}

export interface MemoryEnv {
  /** Absolute directory holding `facts.jsonl`, `INDEX.md` and `audit.jsonl`. */
  dataDir: string
  /** Shared bearer token for `POST /internal/memory`. Never logged. */
  internalToken: string
}

/**
 * The store is the BFF's own file tree, so a relative value would land in
 * whichever directory happened to start the process and a `..` segment could
 * point it outside the mounted `memory-data` volume. Both are boot errors, not
 * warnings: a silently relocated store is worse than a refused start.
 */
function readDataDir(raw: string | undefined): string {
  const value = (raw ?? "").trim()
  if (!value) return DEFAULT_MEMORY_DATA_DIR
  if (!isAbsolute(value)) {
    throw new Error("MEMORY_DATA_DIR must be an absolute path")
  }
  if (value.includes("\0")) {
    throw new Error("MEMORY_DATA_DIR must not contain a null byte")
  }
  // Splitting on both separators also catches a Windows-style escape on a
  // POSIX host, where `normalize` would otherwise leave the backslash alone.
  if (value.split(/[\\/]/).includes("..")) {
    throw new Error("MEMORY_DATA_DIR must not contain '..'")
  }
  const normalized = normalize(value)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

/**
 * The bearer token is required in production and generated for a development
 * boot. A generated token cannot reach the MCP tool process unless both sides
 * are configured with the same value, which is why the boot says so.
 */
function readInternalToken(
  raw: string | undefined,
  options: { production: boolean; warn(message: string): void },
): string {
  const token = raw ?? ""
  if (token.length > 0 && token.length < MIN_MEMORY_INTERNAL_TOKEN_LENGTH) {
    throw new Error(
      `MEMORY_INTERNAL_TOKEN must be at least ${MIN_MEMORY_INTERNAL_TOKEN_LENGTH} characters`,
    )
  }
  if (token.length > 0) return token
  if (options.production) {
    throw new Error("MEMORY_INTERNAL_TOKEN must be set when NODE_ENV=production")
  }
  options.warn("MEMORY_INTERNAL_TOKEN is unset; generated an ephemeral token for this boot")
  return randomBytes(32).toString("base64url")
}

/** Validates both halves; no memory token value is ever echoed. */
export function loadMemoryEnv(
  input: MemoryEnvInput,
  options: { production: boolean; warn(message: string): void },
): MemoryEnv {
  return {
    dataDir: readDataDir(input.dataDir),
    internalToken: readInternalToken(input.internalToken, options),
  }
}
