/**
 * Consent and Cache Storage ownership for the on-device model (issue #47).
 *
 * The cache name is versioned from the pinned manifest. The service worker
 * must never precache `/models/`; this cache is separate and is deleted only
 * by `deleteLocalModel` or by the targeted version migration below.
 */
import {
  STT_MODEL_CACHE_NAME,
  STT_MODEL_DIR,
  STT_MODEL_VERSION,
  STT_MODEL_TOTAL_BYTES,
  sttCacheKey,
} from "@openchat/contracts"

const CONSENT_KEY = "openchat.stt.consent"
const CACHE_PREFIX = "openchat-stt-"
/** Below this relative size change a prior consent still covers a new version. */
const SIGNIFICANT_SIZE_CHANGE = 0.1

export type ConsentDecision = "accepted" | "declined" | "server"

export interface ConsentState {
  version: string
  decision: ConsentDecision
  totalBytes: number
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function cacheStorage(): CacheStorage | null {
  return typeof caches === "undefined" ? null : caches
}

export function readConsent(): ConsentState | null {
  const raw = storage()?.getItem(CONSENT_KEY)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.version !== "string" ||
      typeof record.totalBytes !== "number" ||
      (record.decision !== "accepted" && record.decision !== "declined" && record.decision !== "server")
    ) {
      return null
    }
    return {
      version: record.version,
      totalBytes: record.totalBytes,
      decision: record.decision,
    }
  } catch {
    return null
  }
}

export function writeConsent(decision: ConsentDecision): void {
  const state: ConsentState = {
    version: STT_MODEL_VERSION,
    decision,
    totalBytes: STT_MODEL_TOTAL_BYTES,
  }
  storage()?.setItem(CONSENT_KEY, JSON.stringify(state))
}

export function clearConsent(): void {
  storage()?.removeItem(CONSENT_KEY)
}

/** True when the versioned cache already holds a complete model set. */
export async function isLocalModelCached(): Promise<boolean> {
  const store = cacheStorage()
  if (!store) return false
  try {
    const cache = await store.open(STT_MODEL_CACHE_NAME)
    const probe = await cache.match(sttCacheKey(`${STT_MODEL_DIR}/config.json`))
    return Boolean(probe)
  } catch {
    return false
  }
}

/**
 * Removes every stale STT cache and migrates a stored consent to the current
 * manifest. A substantially larger or smaller model needs fresh consent; a
 * small revision keeps the previous decision (and therefore stays silent).
 */
export async function prepareLocalModel(): Promise<ConsentState | null> {
  const store = cacheStorage()
  if (store) {
    const names = await store.keys().catch(() => [])
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== STT_MODEL_CACHE_NAME)
        .map((name) => store.delete(name).catch(() => false)),
    )
  }
  const state = readConsent()
  if (!state) return null
  if (state.version !== STT_MODEL_VERSION) {
    const previous = state.totalBytes > 0 ? state.totalBytes : STT_MODEL_TOTAL_BYTES
    const change = Math.abs(STT_MODEL_TOTAL_BYTES - previous) / previous
    if (change >= SIGNIFICANT_SIZE_CHANGE) {
      clearConsent()
      return null
    }
    writeConsent(state.decision)
  }
  return readConsent()
}

/** Removes the cached weights and resets consent so the next press asks again. */
export async function deleteLocalModel(): Promise<void> {
  const store = cacheStorage()
  if (store) {
    const names = await store.keys().catch(() => [])
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => store.delete(name).catch(() => false)),
    )
  }
  clearConsent()
}

/** Cache name handed to the worker; exported for tests and diagnostics. */
export function currentCacheName(): string {
  return STT_MODEL_CACHE_NAME
}
