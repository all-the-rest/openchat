import type { SessionInfo } from "@openchat/contracts"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { api } from "../api/client"

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

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSessions()
      setSessions(list)
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

  const create = useCallback(async () => {
    const session = await api.createSession({})
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
