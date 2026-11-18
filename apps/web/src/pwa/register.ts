/**
 * Service-worker registration and update signalling.
 *
 * Registration happens only in production builds (dev uses Vite's dev server
 * with no worker). A new deployment installs a new worker with a new version;
 * it waits rather than taking over. The app surfaces that wait as an explicit
 * notice and only reloads when the user asks for it.
 */
const SKIP_WAITING = "SKIP_WAITING"

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed registration leaves the app fully usable online.
    })
  })
}

/** Reports the waiting (new) worker whenever it appears, including on mount. */
export function subscribeWaiting(listener: (worker: ServiceWorker | null) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    listener(null)
    return () => {}
  }

  const container = navigator.serviceWorker
  let disposed = false
  let registration: ServiceWorkerRegistration | null = null
  const publish = (): void => {
    if (!disposed) listener(registration?.waiting ?? null)
  }
  const onUpdateFound = (): void => {
    const installing = registration?.installing
    if (installing) {
      const onState = (): void => {
        if (installing.state === "installed") publish()
      }
      installing.addEventListener("statechange", onState)
    }
    publish()
  }

  void container.ready
    .then((ready) => {
      registration = ready
      publish()
      ready.addEventListener("updatefound", onUpdateFound)
    })
    .catch(() => publish())

  return () => {
    disposed = true
    registration?.removeEventListener("updatefound", onUpdateFound)
  }
}

/**
 * Explicit, user-triggered activation. The caller must have checked that no
 * answer is streaming; this function never runs on its own and never reloads
 * silently.
 */
export function requestReload(worker: ServiceWorker): void {
  worker.postMessage({ type: SKIP_WAITING })
  window.location.reload()
}
