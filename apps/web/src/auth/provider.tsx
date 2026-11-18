import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { api, ApiError } from "../api/client"
import { clearLastUser, readLastUser, writeLastUser } from "./last-user"
import { getOfflineSnapshot } from "../pwa/offline"

export type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error"

export interface AuthValue {
  status: AuthStatus
  user: string | null
  signIn(user: string, password: string): Promise<void>
  signOut(): Promise<void>
  retry(): Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading")
  const [user, setUser] = useState<string | null>(null)

  const bootstrap = useCallback(async () => {
    setStatus("loading")
    try {
      const me = await api.me()
      writeLastUser(me.user)
      setUser(me.user)
      setStatus("authenticated")
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        clearLastUser()
        setUser(null)
        setStatus("unauthenticated")
        return
      }
      // Offline with a remembered name: render the read-only shell so the
      // offline banner and disabled composer explain the state. The cookie
      // still gates every API call when the connection returns.
      const remembered = getOfflineSnapshot() ? readLastUser() : null
      if (remembered) {
        setUser(remembered)
        setStatus("authenticated")
        return
      }
      setStatus("error")
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const signIn = useCallback(async (user: string, password: string) => {
    const result = await api.login(user, password)
    writeLastUser(result.user)
    setUser(result.user)
    setStatus("authenticated")
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // The client state is cleared regardless; the cookie may already be gone.
    } finally {
      clearLastUser()
      setUser(null)
      setStatus("unauthenticated")
    }
  }, [])

  const value = useMemo<AuthValue>(
    () => ({ status, user, signIn, signOut, retry: bootstrap }),
    [status, user, signIn, signOut, bootstrap],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error("useAuth must be used inside AuthProvider")
  return value
}
