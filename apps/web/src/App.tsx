import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import type { ReactNode } from "react"
import { AppsPage } from "./apps/AppsPage"
import { ArtifactsPage } from "./artifacts/ArtifactsPage"
import { ArtifactViewer } from "./artifacts/ArtifactViewer"
import { AuthProvider, useAuth } from "./auth/provider"
import { AppShell } from "./components/AppShell"
import { EventStreamProvider } from "./api/events"
import { SessionsProvider } from "./chat/sessions"
import { CodePage } from "./code/CodePage"
import { SurfaceHome, SurfaceProvider, useSurface } from "./code/SurfaceProvider"
import { I18nProvider, useT } from "./i18n/provider"
import { ChatPage } from "./pages/ChatPage"
import { LandingPage } from "./pages/LandingPage"
import { LoginPage } from "./pages/LoginPage"
import { SearchPage } from "./search/SearchPage"
import { ThemeProvider } from "./theme/provider"

function ProtectedShell() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return (
    <SurfaceProvider>
      <SessionsProvider>
        <EventStreamProvider>
          <AppShell />
        </EventStreamProvider>
      </SessionsProvider>
    </SurfaceProvider>
  )
}

/**
 * `/code` is unavailable unless `/api/info` reports a configured Code host;
 * a direct visit falls back to chat, exactly like the hidden switch.
 */
export function CodeRoute() {
  const { configured } = useSurface()

  if (configured === false) return <Navigate to="/" replace />
  if (configured !== true) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="loading loading-spinner loading-md" aria-hidden="true" />
      </div>
    )
  }
  return <CodePage />
}

/**
 * `/apps` is unavailable unless `/api/info` reports an app surface; a direct
 * visit falls back to chat, exactly like an unconfigured `/code`.
 */
export function AppsRoute() {
  const { appsAvailable } = useSurface()

  if (appsAvailable === false) return <Navigate to="/" replace />
  if (appsAvailable !== true) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="loading loading-spinner loading-md" aria-hidden="true" />
      </div>
    )
  }
  return <AppsPage />
}

/**
 * `/artifacts` and `/artifacts/:id` exist only when `/api/info` reports the
 * artifact surface. An unconfigured deployment has no entry and no route: a
 * direct visit falls back to chat, exactly like `/apps`.
 */
export function ArtifactsRoute({ children }: { children: ReactNode }) {
  const { artifactsAvailable } = useSurface()

  if (artifactsAvailable === false) return <Navigate to="/" replace />
  if (artifactsAvailable !== true) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="loading loading-spinner loading-md" aria-hidden="true" />
      </div>
    )
  }
  return <>{children}</>
}

function BootScreen() {
  const t = useT()
  return (
    <main className="flex h-dvh items-center justify-center bg-app text-base-content">
      <span className="loading loading-spinner loading-md" aria-hidden="true" />
      <span className="ms-3 text-sm text-muted">{t("app.loading")}</span>
    </main>
  )
}

function BootError({ onRetry }: { onRetry(): Promise<void> }) {
  const t = useT()
  return (
    <main className="flex h-dvh items-center justify-center bg-app px-4 text-base-content">
      <div className="w-full max-w-sm rounded-card border border-subtle bg-surface p-6 text-center">
        <p role="alert" className="text-sm text-error">
          {t("auth.bootFailed")}
        </p>
        <button
          type="button"
          onClick={() => void onRetry()}
          className="btn btn-primary btn-sm mt-4"
        >
          {t("auth.retry")}
        </button>
      </div>
    </main>
  )
}

function AppRoutes() {
  const auth = useAuth()

  if (auth.status === "loading") return <BootScreen />
  if (auth.status === "error") return <BootError onRetry={auth.retry} />

  return (
    <Routes>
      <Route
        path="/login"
        element={
          auth.status === "authenticated" ? <Navigate to="/" replace /> : <LoginPage />
        }
      />
      <Route element={<ProtectedShell />}>
        <Route
          path="/"
          element={
            <SurfaceHome>
              <LandingPage />
            </SurfaceHome>
          }
        />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/c/:sessionId" element={<ChatPage />} />
        <Route path="/c/:sessionId/:messageId" element={<ChatPage />} />
        <Route path="/code" element={<CodeRoute />} />
        <Route path="/code/*" element={<CodeRoute />} />
        <Route path="/apps" element={<AppsRoute />} />
        <Route
          path="/artifacts"
          element={
            <ArtifactsRoute>
              <ArtifactsPage />
            </ArtifactsRoute>
          }
        />
        <Route
          path="/artifacts/:id"
          element={
            <ArtifactsRoute>
              <ArtifactViewer />
            </ArtifactsRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
