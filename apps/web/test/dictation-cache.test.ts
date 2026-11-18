import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  STT_MODEL_CACHE_NAME,
  STT_MODEL_DIR,
  STT_MODEL_TOTAL_BYTES,
  STT_MODEL_VERSION,
  sttCacheKey,
} from "@openchat/contracts"
import {
  deleteLocalModel,
  isLocalModelCached,
  prepareLocalModel,
  readConsent,
  writeConsent,
} from "../src/dictation/local-cache"

interface FakeCache {
  entries: Map<string, Response>
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

function fakeCacheStorage() {
  const stores = new Map<string, FakeCache>()
  const cacheStorage = {
    async open(name: string) {
      let cache = stores.get(name)
      if (!cache) {
        const entries = new Map<string, Response>()
        cache = {
          entries,
          match: async (key: string) => entries.get(key),
          put: async (key: string, response: Response) => void entries.set(key, response),
        }
        stores.set(name, cache)
      }
      return {
        match: cache.match,
        put: cache.put,
      }
    },
    keys: async () => [...stores.keys()],
    delete: vi.fn(async (name: string) => stores.delete(name)),
  }
  vi.stubGlobal("caches", cacheStorage)
  return { cacheStorage, stores }
}

beforeEach(() => {
  localStorage.clear()
  fakeCacheStorage()
})

afterEach(() => vi.unstubAllGlobals())

describe("versioned local model cache", () => {
  it("loads the cached model without a network request", async () => {
    const { cacheStorage } = fakeCacheStorage()
    const cache = await cacheStorage.open(STT_MODEL_CACHE_NAME)
    await cache.put(sttCacheKey(`${STT_MODEL_DIR}/config.json`), new Response("{}"))
    expect(await isLocalModelCached()).toBe(true)
  })

  it("deletes stale version caches on startup", async () => {
    const { cacheStorage } = fakeCacheStorage()
    await cacheStorage.open("openchat-stt-oldversion")
    await cacheStorage.open(STT_MODEL_CACHE_NAME)
    writeConsent("accepted")
    await prepareLocalModel()
    expect(cacheStorage.delete).toHaveBeenCalledWith("openchat-stt-oldversion")
    expect(cacheStorage.delete).not.toHaveBeenCalledWith(STT_MODEL_CACHE_NAME)
  })

  it("keeps consent across a small manifest revision", async () => {
    localStorage.setItem(
      "openchat.stt.consent",
      JSON.stringify({
        version: "oldrevision",
        decision: "accepted",
        totalBytes: STT_MODEL_TOTAL_BYTES - 1000,
      }),
    )
    const state = await prepareLocalModel()
    expect(state?.decision).toBe("accepted")
    expect(readConsent()?.version).toBe(STT_MODEL_VERSION)
  })

  it("asks again when the manifest size changes significantly", async () => {
    localStorage.setItem(
      "openchat.stt.consent",
      JSON.stringify({ version: "oldrevision", decision: "accepted", totalBytes: 1000 }),
    )
    const state = await prepareLocalModel()
    expect(state).toBeNull()
    expect(readConsent()).toBeNull()
  })

  it("deletes the cache and resets consent", async () => {
    const { cacheStorage } = fakeCacheStorage()
    await cacheStorage.open(STT_MODEL_CACHE_NAME)
    writeConsent("accepted")
    await deleteLocalModel()
    expect(cacheStorage.delete).toHaveBeenCalledWith(STT_MODEL_CACHE_NAME)
    expect(readConsent()).toBeNull()
    expect(await isLocalModelCached()).toBe(false)
  })
})
