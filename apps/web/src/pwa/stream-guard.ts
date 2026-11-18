import { useSyncExternalStore } from "react"

/**
 * Shell-wide "an answer is in progress" flag. The update notice uses it to
 * withhold the reload action: activating a new worker mid-stream would cut the
 * response off. Streams set it from `useChatSession`; no polling is involved.
 */
let active = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setStreamActive(next: boolean): void {
  if (active === next) return
  active = next
  emit()
}

export function getStreamActive(): boolean {
  return active
}

export function subscribeStreamActive(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStreamActive(): boolean {
  return useSyncExternalStore(subscribeStreamActive, getStreamActive, () => false)
}
