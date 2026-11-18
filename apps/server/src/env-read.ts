/**
 * Small environment readers shared by `loadEnv`. They only parse a string and
 * report a warning; every domain-specific rule stays in `env.ts` so a typo is
 * refused where the value is used.
 */
export function read(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Secrets keep their exact characters; only an empty value counts as unset. */
export function readSecret(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined || value.trim().length === 0) return undefined
  return value
}

export function readNumber(
  source: Record<string, string | undefined>,
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

export function readBoolean(
  source: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = read(source, key)?.toLowerCase()
  return value === "1" || value === "true" || value === "on" || value === "yes"
}
