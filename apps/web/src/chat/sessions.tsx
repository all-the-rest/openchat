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
import { useCompletionOrNull } from "./completion"

export interface SessionsValue {
  sessions: SessionInfo[]
  loading: boolean
  failed: boolean
  refresh(): Promise<void>
  create(): Promise<SessionInfo>
  /** Renames one chat and updates the list with the row the BFF returns. */
  rename(sessionID: string, title: string): Promise<SessionInfo>
  /** Deletes one chat and drops it from the list. */
  remove(sessionID: string): Promise<void>
}

const SessionsContext = createContext<SessionsValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const surface = useSurfaceOrNull()
  const hostReachable = surface?.hostReachable ?? null
  /**
   * Sessions this tab created. A list request that started before the create
   * resolves afterwards and would otherwise drop the new row from the sidebar
   * (the host does not know it yet in that answer).
   */
  const createdHere = useRef(new Set<string>())
  const completion = useCompletionOrNull()

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

  // A chat created inside the Code surface (or by the host) is only discovered
  // by `GET /api/sessions`. One refresh per switch back to Chat keeps the
  // sidebar current without polling; the initial page load already refreshed.
  const activeSurface = surface?.surface ?? null
  const previousSurface = useRef(activeSurface)
  useEffect(() => {
    const previous = previousSurface.current
    previousSurface.current = activeSurface
    if (previous === "code" && activeSurface === "chat") void refresh()
  }, [activeSurface, refresh])

  const create = useCallback(async () => {
    // The browser default is the model of a new chat; a browser without a
    // choice lets the host keep its own default.
    const session = await api.createSession({
      model: completion?.model ?? undefined,
      agent: completion?.agent ?? undefined,
    })
    createdHere.current.add(session.id)
    setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)])
    return session
  }, [completion?.model, completion?.agent])

  const rename = useCallback(async (sessionID: string, title: string) => {
    const updated = await api.renameSession(sessionID, title)
    setSessions((current) =>
      current.map((session) => (session.id === updated.id ? updated : session)),
    )
    return updated
  }, [])

  const remove = useCallback(async (sessionID: string) => {
    await api.deleteSession(sessionID)
    createdHere.current.delete(sessionID)
    setSessions((current) => current.filter((session) => session.id !== sessionID))
  }, [])

  const value = useMemo<SessionsValue>(
    () => ({ sessions, loading, failed, refresh, create, rename, remove }),
    [sessions, loading, failed, refresh, create, rename, remove],
  )

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessions(): SessionsValue {
  const value = useContext(SessionsContext)
  if (!value) throw new Error("useSessions must be used inside SessionsProvider")
  return value
}
