import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Navigate, useLocation, useNavigate } from "react-router-dom"
import { api } from "../api/client"
import {
  readSurface,
  surfaceForPath,
  surfacePath,
  writeSurface,
  type Surface,
} from "./surface"

export interface SurfaceValue {
  /** `null` until `/api/info` answered; false hides the switch entirely. */
  configured: boolean | null
  /**
   * `apps.available` from the same `/api/info` response; `null` until it
   * answered. False hides the `/apps` entry and redirects the route home.
   */
  appsAvailable: boolean | null
  /** The surface the current route belongs to. */
  surface: Surface
  /** The persisted choice, used only to restore `/` on a fresh load. */
  stored: Surface
  /** Persists a choice without navigating (sidebar links use this). */
  setSurface(surface: Surface): void
  /** Persists a choice and navigates to its surface. */
  choose(surface: Surface): void
  toggle(): void
}

const SurfaceContext = createContext<SurfaceValue | null>(null)

/**
 * Reads `code.configured` and `apps.available` from the single `/api/info`
 * response and owns the Chat | Code shortcut. A failed info call means "not
 * configured": the switch and the apps entry stay hidden and their routes
 * redirect home.
 */
export function SurfaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [appsAvailable, setAppsAvailable] = useState<boolean | null>(null)
  const [stored, setStored] = useState<Surface>(() => readSurface())

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const info = await api.info()
        if (mounted) {
          setConfigured(info?.code?.configured === true)
          setAppsAvailable(info?.apps?.available === true)
        }
      } catch {
        if (mounted) {
          setConfigured(false)
          setAppsAvailable(false)
        }
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const surface = surfaceForPath(location.pathname)
  const previousPath = useRef(location.pathname)

  // Navigating to a chat route (a session link, search, the switch) makes
  // "chat" the remembered choice, so the next `/` does not bounce to Code.
  // The initial path is skipped: `/` restores the stored surface via
  // `SurfaceHome` instead of overwriting it.
  useEffect(() => {
    if (previousPath.current === location.pathname) return
    previousPath.current = location.pathname
    writeSurface(surface)
    setStored(surface)
  }, [location.pathname, surface])

  const setSurface = useCallback((next: Surface) => {
    writeSurface(next)
    setStored(next)
  }, [])

  const choose = useCallback(
    (next: Surface) => {
      setSurface(next)
      navigate(surfacePath(next))
    },
    [navigate, setSurface],
  )

  const toggle = useCallback(() => {
    choose(surface === "code" ? "chat" : "code")
  }, [choose, surface])

  // Cmd/Ctrl+Shift+O is the browser's bookmark manager; the surface owns it.
  useEffect(() => {
    if (configured !== true) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "o") return
      event.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [configured, toggle])

  const value = useMemo<SurfaceValue>(
    () => ({ configured, appsAvailable, surface, stored, setSurface, choose, toggle }),
    [configured, appsAvailable, surface, stored, setSurface, choose, toggle],
  )

  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>
}

export function useSurface(): SurfaceValue {
  const value = useContext(SurfaceContext)
  if (!value) throw new Error("useSurface must be used inside SurfaceProvider")
  return value
}

/**
 * `/` restores the last surface on a fresh app boot: after a reload of the app
 * root, a persisted `code` choice reopens Code. Client-side arrivals at `/`
 * (Back, a link) carry their own history key and stay in chat; every
 * navigation that means "chat" persists `chat` first anyway.
 */
export function SurfaceHome({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { configured, stored } = useSurface()
  const boot = location.key === "default"
  if (boot && configured === true && stored === "code") {
    return <Navigate to="/code" replace />
  }
  return <>{children}</>
}
