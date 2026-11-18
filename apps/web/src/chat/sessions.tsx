import type { SessionInfo } from "@openchat/contracts"
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
import { api } from "../api/client"
import { useSurfaceOrNull } from "../code/SurfaceProvider"

export interface SessionsValue {
  sessions: SessionInfo[]
  loading: boolean
  failed: boolean
  refresh(): Promise<void>
  create(): Promise<SessionInfo>
}

const SessionsContext = createContext<SessionsValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const hostReachable = useSurfaceOrNull()?.hostReachable ?? null
  /**
   * Sessions this tab created. A list request that started before the create
   * resolves afterwards and would otherwise drop the new row from the sidebar
   * (the host does not know it yet in that answer).
   */
  const createdHere = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSessions()
      setSessions((current) => {
        const known = new Set(list.map((session) => session.id))
        const pending = current.filter(
          (session) => createdHere.current.has(session.id) && !known.has(session.id),
        )
        return pending.length === 0 ? list : [...pending, ...list]
      })
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The sidebar failed while the host was gone; a recovered host gets one
  // silent retry, so the list returns with the banner, not behind its own button.
  const previousReachable = useRef(hostReachable)
  useEffect(() => {
    const previous = previousReachable.current
    previousReachable.current = hostReachable
    if (previous === false && hostReachable === true) void refresh()
  }, [hostReachable, refresh])

  const create = useCallback(async () => {
    const session = await api.createSession({})
    createdHere.current.add(session.id)
    setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)])
    return session
  }, [])

  const value = useMemo<SessionsValue>(
    () => ({ sessions, loading, failed, refresh, create }),
    [sessions, loading, failed, refresh, create],
  )

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessions(): SessionsValue {
  const value = useContext(SessionsContext)
  if (!value) throw new Error("useSessions must be used inside SessionsProvider")
  return value
}
