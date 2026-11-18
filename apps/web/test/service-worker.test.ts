import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = readFileSync(join(WEB_DIR, "public", "sw.js"), "utf8")
const ORIGIN = "https://app.test"

type Listener = (event: FakeEvent) => void

interface FakeEvent {
  request?: Request
  mode?: string
  data?: unknown
  respondWith?: (result: Promise<Response> | Response) => void
  waitUntil?: (promise: Promise<unknown>) => void
}

interface WorkerApi {
  VERSION: string
  SHELL_CACHE: string
  PRECACHE: string[]
  isApi(url: URL): boolean
  isCacheable(request: Request, url: URL): boolean
  offlineApiResponse(): Response
  install(): Promise<void>
  activate(): Promise<void>
  handleFetch(event: FakeEvent): void
}

interface Harness {
  api: WorkerApi
  listeners: Map<string, Listener[]>
  store: Map<string, Response>
  cachesOpen: ReturnType<typeof vi.fn>
  cacheDelete: ReturnType<typeof vi.fn>
  fetchMock: ReturnType<typeof vi.fn>
  skipWaiting: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
}

function keyOf(value: Request | string): string {
  return typeof value === "string" ? new URL(value, ORIGIN).href : value.url
}

function fakeRequest(url: string, mode = "no-cors"): Request {
  return { url: new URL(url, ORIGIN).href, method: "GET", mode } as unknown as Request
}

function loadWorker(online = true): Harness {
  const store = new Map<string, Response>()
  const cache = {
    addAll: async (paths: string[]) => {
      for (const path of paths) store.set(keyOf(path), new Response("shell"))
    },
    match: async (value: Request | string) => store.get(keyOf(value)),
    put: async (value: Request | string, response: Response) => {
      store.set(keyOf(value), response)
    },
  }
  const cachesOpen = vi.fn(async (_name: string) => cache)
  const cacheDelete = vi.fn(async (_name: string) => true)
  const caches = {
    open: cachesOpen,
    keys: async () => ["openchat-shell-dev", "openchat-shell-old", "unrelated"],
    delete: cacheDelete,
  }
  const fetchMock = vi.fn(async (_request: Request) => {
    if (!online) throw new TypeError("Failed to fetch")
    return new Response("network")
  })
  const listeners = new Map<string, Listener[]>()
  const skipWaiting = vi.fn(async () => undefined)
  const claim = vi.fn(async () => undefined)
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    skipWaiting,
    clients: { claim },
  }

  const source = SOURCE.replace(
    /const PRECACHE = \[[^\]]*\]/,
    `const PRECACHE = ${JSON.stringify(["/", "/index.html", "/manifest.webmanifest", "/assets/index-abc123.js"])}`,
  )
  runInNewContext(source, {
    self: scope,
    Response,
    URL,
    caches,
    fetch: fetchMock,
  })
  const api = (scope as unknown as { __openchatSW: WorkerApi }).__openchatSW
  return { api, listeners, store, cachesOpen, cacheDelete, fetchMock, skipWaiting, claim }
}

interface FetchEventHarness {
  event: FakeEvent
  result(): Promise<Response> | undefined
}

function fetchEvent(request: Request): FetchEventHarness {
  let result: Promise<Response> | undefined
  return {
    event: {
      request,
      respondWith(value) {
        result = Promise.resolve(value) as Promise<Response>
      },
    },
    result: () => result,
  }
}

describe("service worker routing", () => {
  it("registers install, activate, fetch and message handlers", () => {
    const { listeners } = loadWorker()
    expect([...listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "message"])
  })

  it("classifies only API paths as API traffic", () => {
    const { api } = loadWorker()
    expect(api.isApi(new URL("/api/info", ORIGIN))).toBe(true)
    expect(api.isApi(new URL("/api", ORIGIN))).toBe(true)
    expect(api.isApi(new URL("/assets/app.js", ORIGIN))).toBe(false)
    expect(api.isApi(new URL("/api-extra/info", ORIGIN))).toBe(false)
  })

  it("never reads or writes a cache for an API request", async () => {
    const { api, cachesOpen, fetchMock } = loadWorker()
    const { event, result } = fetchEvent(fakeRequest("/api/sessions"))
    api.handleFetch(event)
    await result()!

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cachesOpen).not.toHaveBeenCalled()
  })

  it("returns a structured offline error for a failed API call, still without caching", async () => {
    const { api, cachesOpen } = loadWorker(false)
    const { event, result } = fetchEvent(fakeRequest("/api/prompts"))
    api.handleFetch(event)
    const response = await result()!

    expect(response.status).toBe(503)
    expect(response.headers.get("x-openchat-offline")).toBe("1")
    expect(await response.json()).toEqual({
      error: { code: "offline", message: "offline" },
    })
    expect(cachesOpen).not.toHaveBeenCalled()
  })

  it("serves a precached asset from cache when offline", async () => {
    const { api, store, fetchMock } = loadWorker(false)
    const asset = "/assets/index-abc123.js"
    const expected = new Response("cached-asset")
    store.set(keyOf(asset), expected)

    const { event, result } = fetchEvent(fakeRequest(asset))
    api.handleFetch(event)
    const response = await result()!

    expect(await response.text()).toBe("cached-asset")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back to the cached shell for an offline navigation", async () => {
    const { api, store } = loadWorker(false)
    store.set(keyOf("/index.html"), new Response("offline-shell"))

    const { event, result } = fetchEvent(fakeRequest("/c/session-1", "navigate"))
    api.handleFetch(event)
    expect(await (await result()!).text()).toBe("offline-shell")
  })

  it("install precaches the allowlist and waits for the user", async () => {
    const { api, cachesOpen, store, skipWaiting } = loadWorker()
    await api.install()

    expect(cachesOpen).toHaveBeenCalledWith("openchat-shell-dev")
    expect(store.size).toBe(api.PRECACHE.length)
    expect(skipWaiting).not.toHaveBeenCalled()
  })

  it("activate deletes only stale versions and claims clients", async () => {
    const { api, cacheDelete, claim } = loadWorker()
    await api.activate()

    expect(cacheDelete).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledWith("openchat-shell-old")
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it("ignores cross-origin and non-GET requests", () => {
    const { api } = loadWorker()
    const { event: cross, result: crossResult } = fetchEvent(fakeRequest("https://cdn.test/lib.js"))
    api.handleFetch(cross)
    expect(crossResult()).toBeUndefined()

    const post = new Request(`${ORIGIN}/api/prompts`, { method: "POST" })
    const { event, result } = fetchEvent(post)
    api.handleFetch(event)
    expect(result()).toBeUndefined()
  })

  it("activates a waiting worker only on an explicit SKIP_WAITING message", () => {
    const { listeners, skipWaiting } = loadWorker()
    const message = listeners.get("message")?.[0]
    expect(message).toBeDefined()

    message?.({ data: { type: "UNRELATED" } })
    expect(skipWaiting).not.toHaveBeenCalled()
    message?.({ data: { type: "SKIP_WAITING" } })
    expect(skipWaiting).toHaveBeenCalledTimes(1)
  })
})
