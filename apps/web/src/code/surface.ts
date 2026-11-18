/**
 * Chat | Code surface selection (spec 13).
 *
 * The route is the source of truth for what is on screen: `/code` and
 * `/code/*` are the Code surface, everything else is chat. The stored value
 * only restores the last choice when the app opens at `/`.
 */
export type Surface = "chat" | "code"

export const SURFACE_STORAGE_KEY = "openchat.surface"

export function isSurface(value: unknown): value is Surface {
  return value === "chat" || value === "code"
}

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Stored choice, defaulting to `chat` for a missing or malformed value. */
export function readSurface(storage: Storage | null = defaultStorage()): Surface {
  if (!storage) return "chat"
  try {
    const stored = storage.getItem(SURFACE_STORAGE_KEY)
    return isSurface(stored) ? stored : "chat"
  } catch {
    return "chat"
  }
}

/** Persists the choice; storage is best effort, the UI still switches. */
export function writeSurface(surface: Surface, storage: Storage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(SURFACE_STORAGE_KEY, surface)
  } catch {
    // Private mode or a blocked storage partition: keep the in-memory choice.
  }
}

/** `/code` and `/code/*` are Code; `/` and every chat route are Chat. */
export function surfaceForPath(pathname: string): Surface {
  return pathname === "/code" || pathname.startsWith("/code/") ? "code" : "chat"
}

/** Where selecting a surface lands. Chat is always the app root. */
export function surfacePath(surface: Surface): string {
  return surface === "code" ? "/code" : "/"
}

/**
 * Maps the app path to the `next` path on the Code host. `/code` is `/`, and
 * `/code/workspace/x` is `/workspace/x`; empty segments collapse so a stray
 * double slash cannot become a protocol-relative path.
 */
export function codeDeepLink(pathname: string): string {
  const rest =
    pathname === "/code"
      ? ""
      : pathname.startsWith("/code/")
        ? pathname.slice("/code".length)
        : ""
  const segments = rest.split("/").filter((segment) => segment.length > 0)
  return segments.length === 0 ? "/" : `/${segments.join("/")}`
}
