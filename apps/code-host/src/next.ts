/**
 * Validates the post-ticket redirect target.
 *
 * Only a path on this origin is allowed: the redirect must not become an open
 * redirect through a ticket link. Anything suspicious falls back to `/`
 * instead of failing the sign-in, so a broken `next` never locks the owner out.
 */

function hasScheme(value: string): boolean {
  return /^\/[a-z][a-z0-9+.-]*:/i.test(value)
}

/** Structural dangers: another origin, a backslash, control bytes, a scheme. */
function unsafeStructure(value: string): boolean {
  if (!value.startsWith("/")) return true
  // `//host` is protocol-relative and would leave this origin.
  if (value.startsWith("//")) return true
  if (value.includes("\\")) return true
  if (/[\u0000-\u001f\u007f]/.test(value)) return true
  return hasScheme(value)
}

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/"
  // Whitespace can smuggle a second location into the header.
  if (/\s/.test(raw)) return "/"
  if (unsafeStructure(raw)) return "/"
  // A percent-encoded backslash or slash can become one after the browser or
  // a downstream server decodes it; check the decoded structure too. A normal
  // encoded segment (a space in a session title) stays valid.
  if (raw.includes("%")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return "/"
    }
    if (unsafeStructure(decoded)) return "/"
  }
  return raw
}
