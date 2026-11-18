/**
 * Scalar readers shared by the BFF configuration loader. They live apart from
 * `env.ts` so the loader itself stays within the file-length budget; none of
 * them keeps state or knows a concrete variable beyond the key it is given.
 */

export type EnvSource = Record<string, string | undefined>

export function read(source: EnvSource, key: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Secrets keep their exact characters; only an empty value counts as unset. */
export function readSecret(source: EnvSource, key: string): string | undefined {
  const value = source[key]
  if (value === undefined || value.trim().length === 0) return undefined
  return value
}

export function readNumber(
  source: EnvSource,
  key: string,
  fallback: number,
  warn: (message: string) => void,
): number {
  const value = read(source, key)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warn(`${key} must be a positive integer; using the default`)
    return fallback
  }
  return parsed
}

/** A TCP port; anything outside `1..65535` would fail later inside `listen`. */
export function readPort(
  source: EnvSource,
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

/** A token budget where `0` is a meaningful "off"; anything else must be positive. */
export function readTokenCap(
  source: EnvSource,
  key: string,
  fallback: number,
  warn: (message: string) => void,
): number {
  const value = read(source, key)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    warn(`${key} must be a non-negative integer; using the default`)
    return fallback
  }
  return parsed
}

export function readBoolean(source: EnvSource, key: string): boolean {
  const value = read(source, key)?.toLowerCase()
  return value === "1" || value === "true" || value === "on" || value === "yes"
}
