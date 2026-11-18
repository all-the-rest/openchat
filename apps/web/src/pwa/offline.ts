import { useSyncExternalStore } from "react"

/**
 * Offline state from two independent signals: the browser's own `onLine` flag
 * and a fetch failure reported by the API client (a captive portal can leave
 * `onLine` true). A successful API response clears only the failure signal;
 * `onLine` is owned by the browser events.
 */
let networkFailed = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function reportNetworkFailure(): void {
  if (networkFailed) return
  networkFailed = true
  emit()
}

export function reportNetworkSuccess(): void {
  if (!networkFailed) return
  networkFailed = false
  emit()
}

export function getOfflineSnapshot(): boolean {
  const browserOffline = typeof navigator !== "undefined" && !navigator.onLine
  return browserOffline || networkFailed
}

export function subscribeOffline(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("online", emit)
    window.addEventListener("offline", emit)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("online", emit)
      window.removeEventListener("offline", emit)
    }
  }
}

export function useOffline(): boolean {
  return useSyncExternalStore(subscribeOffline, getOfflineSnapshot, () => false)
}
