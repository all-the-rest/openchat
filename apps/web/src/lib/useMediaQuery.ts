import { useCallback, useSyncExternalStore } from "react"

function queryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(query)
}

function listen(query: string, onChange: () => void): () => void {
  const list = queryList(query)
  if (!list) return () => {}
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }
  // Safari before 14 only offers the deprecated listener API.
  list.addListener(onChange)
  return () => list.removeListener(onChange)
}

/**
 * SSR- and jsdom-safe media query hook. The server snapshot is `false`, so the
 * narrow layout is the safe default; the client reads the real match.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => listen(query, onChange), [query])
  const getSnapshot = useCallback(() => queryList(query)?.matches ?? false, [query])
  const getServerSnapshot = useCallback(() => false, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
