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
  /**
   * `artifacts.available` from `/api/info`; `null` until it answered. False
   * hides the `/artifacts` entry and redirects both routes home.
   */
  artifactsAvailable: boolean | null
  /**
   * `host.reachable` from `/api/info`; `null` until it answered. False means
   * the app is up but the OpenCode host behind it did not answer.
   */
  hostReachable: boolean | null
  /** The surface the current route belongs to. */
  surface: Surface
  /** The persisted choice, used only to restore `/` on a fresh load. */
  stored: Surface
  /** Persists a choice without navigating (sidebar links use this). */
  setSurface(surface: Surface): void
  /** Persists a choice and navigates to its surface. */
  choose(surface: Surface): void
  toggle(): void
  /** Re-reads `/api/info`; the host banner's retry action. */
  refresh(): Promise<void>
}

const SurfaceContext = createContext<SurfaceValue | null>(null)

/**
 * Reads the host state plus `code.configured`, `apps.available` and
 * `artifacts.available` from the single `/api/info` response and owns the
 * Chat | Code shortcut. A failed info call means "not configured": the switch,
 * the apps entry and the artifacts entry stay hidden and their routes redirect
 * home. It also counts as an unreachable host, because the banner's retry is the
 * only useful action left.
 */
export function SurfaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [appsAvailable, setAppsAvailable] = useState<boolean | null>(null)
  const [artifactsAvailable, setArtifactsAvailable] = useState<boolean | null>(null)
  const [hostReachable, setHostReachable] = useState<boolean | null>(null)
  const [stored, setStored] = useState<Surface>(() => readSurface())
  // StrictMode runs the mount effect twice and retries can overlap; only the
  // newest answer may update the state.
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const current = (request.current += 1)
    try {
      const info = await api.info()
      if (current !== request.current) return
      setConfigured(info?.code?.configured === true)
      setAppsAvailable(info?.apps?.available === true)
      setArtifactsAvailable(info?.artifacts?.available === true)
      setHostReachable(info?.host?.reachable !== false)
    } catch {
      if (current !== request.current) return
      setConfigured(false)
      setAppsAvailable(false)
      setArtifactsAvailable(false)
      setHostReachable(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  // Cmd/Ctrl+Shift+M toggles the mode ("M" for mode). Cmd+M minimizes the
  // window and the Shift chord is free; Shift+O belongs to new chat (spec 09).
  useEffect(() => {
    if (configured !== true) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "m") return
      event.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [configured, toggle])

  const value = useMemo<SurfaceValue>(
    () => ({
      configured,
      appsAvailable,
      artifactsAvailable,
      hostReachable,
      surface,
      stored,
      setSurface,
      choose,
      toggle,
      refresh,
    }),
    [
      configured,
      appsAvailable,
      artifactsAvailable,
      hostReachable,
      surface,
      stored,
      setSurface,
      choose,
      toggle,
      refresh,
    ],
  )

  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>
}

export function useSurface(): SurfaceValue {
  const value = useContext(SurfaceContext)
  if (!value) throw new Error("useSurface must be used inside SurfaceProvider")
  return value
}

/**
 * Null outside a `SurfaceProvider`. Leaf controls such as the composer can be
 * rendered on their own (tests, embeds); they then simply have no host state.
 */
export function useSurfaceOrNull(): SurfaceValue | null {
  return useContext(SurfaceContext)
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
