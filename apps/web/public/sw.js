/**
 * OpenChat service worker — hand-written, no runtime dependency.
 *
 * The Vite build injects `VERSION` (a hash of the built asset manifest) and
 * `PRECACHE` (the shell plus its hashed assets). A changed version installs a
 * new cache and waits for the app's explicit "reload to update" action; nothing
 * is ever reloaded silently.
 *
 * Cache writes are limited to the PRECACHE allowlist. `/api/*` is always
 * network-first and is never read from or written to a cache — that covers
 * prompts, responses, auth cookies, artifacts and every other API payload.
 */
(function (scope) {
  "use strict"

  // Replaced verbatim by the build plugin; the defaults keep the checked-in
  // source valid (and directly testable) on its own.
  const VERSION = "dev"
  const PRECACHE = ["/", "/index.html", "/manifest.webmanifest"]

  const CACHE_PREFIX = "openchat-shell-"
  const SHELL_CACHE = CACHE_PREFIX + VERSION
  const API_PREFIX = "/api/"
  const OFFLINE_HEADER = "x-openchat-offline"
  const PRECACHE_SET = new Set(PRECACHE)

  function isApi(url) {
    return url.pathname === "/api" || url.pathname.startsWith(API_PREFIX)
  }

  /** Only the explicit shell/static allowlist may ever enter a cache. */
  function isCacheable(request, url) {
    return (
      request.method === "GET" &&
      url.origin === scope.location.origin &&
      !isApi(url) &&
      PRECACHE_SET.has(url.pathname)
    )
  }

  function offlineApiResponse() {
    return new Response(JSON.stringify({ error: { code: "offline", message: "offline" } }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        [OFFLINE_HEADER]: "1",
      },
    })
  }

  async function install() {
    const cache = await caches.open(SHELL_CACHE)
    await cache.addAll(PRECACHE)
    // Deliberately no skipWaiting: the app shows an update notice and only the
    // user's explicit reload activates this worker.
  }

  async function activate() {
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    )
    await scope.clients.claim()
  }

  /** API traffic: network only. A failure becomes a structured offline error. */
  async function networkFirstApi(request) {
    try {
      return await fetch(request)
    } catch {
      return offlineApiResponse()
    }
  }

  /** HTML routes are fetched live; the cached shell is the offline fallback. */
  async function navigate(request) {
    try {
      return await fetch(request)
    } catch {
      const cache = await caches.open(SHELL_CACHE)
      return (
        (await cache.match("/index.html")) ??
        (await cache.match("/")) ??
        new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
      )
    }
  }

  /** Precached assets are immutable: serve them from cache, fill only on miss. */
  async function cacheFirst(request) {
    const cache = await caches.open(SHELL_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && isCacheable(request, new URL(request.url))) {
      await cache.put(request, response.clone())
    }
    return response
  }

  function handleFetch(event) {
    const request = event.request
    const url = new URL(request.url)
    if (url.origin !== scope.location.origin || request.method !== "GET") return

    if (isApi(url)) {
      event.respondWith(networkFirstApi(request))
      return
    }
    if (request.mode === "navigate") {
      event.respondWith(navigate(request))
      return
    }
    if (isCacheable(request, url)) {
      event.respondWith(cacheFirst(request))
    }
  }

  function handleMessage(event) {
    const data = event.data
    if (data && data.type === "SKIP_WAITING") void scope.skipWaiting()
  }

  const api = {
    VERSION,
    SHELL_CACHE,
    PRECACHE,
    isApi,
    isCacheable,
    offlineApiResponse,
    install,
    activate,
    networkFirstApi,
    navigate,
    cacheFirst,
    handleFetch,
    handleMessage,
  }
  // Exposed for the routing tests; harmless in a real worker.
  scope.__openchatSW = api

  if (typeof scope.addEventListener === "function") {
    scope.addEventListener("install", (event) => event.waitUntil(install()))
    scope.addEventListener("activate", (event) => event.waitUntil(activate()))
    scope.addEventListener("fetch", handleFetch)
    scope.addEventListener("message", handleMessage)
  }
})(typeof self !== "undefined" ? self : globalThis)
