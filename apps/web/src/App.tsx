import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { lazy, Suspense, type ReactNode } from "react"
import { AuthProvider, useAuth } from "./auth/provider"
import { CompletionProvider } from "./chat/completion"
import { AppShell } from "./components/AppShell"
import { EventStreamProvider } from "./api/events"
import { SessionsProvider } from "./chat/sessions"
import { SurfaceHome, SurfaceProvider, useSurface } from "./code/SurfaceProvider"
import { I18nProvider, useT } from "./i18n/provider"
import { LandingPage } from "./pages/LandingPage"
import { LoginPage } from "./pages/LoginPage"
import { ThemeProvider } from "./theme/provider"

/**
 * Route-level split (issue #26). Login and the landing page stay in the entry
 * chunk: they are the first paint. Everything else — above all chat with its
 * markdown/Katex/highlight renderer — loads on navigation, so an anonymous
 * visit never downloads transcript code and the chat never blocks boot.
 */
const ChatPage = lazy(() => import("./pages/ChatPage").then((m) => ({ default: m.ChatPage })))
const SearchPage = lazy(() =>
  import("./search/SearchPage").then((m) => ({ default: m.SearchPage })),
)
const CodePage = lazy(() => import("./code/CodePage").then((m) => ({ default: m.CodePage })))
const AppsPage = lazy(() => import("./apps/AppsPage").then((m) => ({ default: m.AppsPage })))
const ArtifactsPage = lazy(() =>
  import("./artifacts/ArtifactsPage").then((m) => ({ default: m.ArtifactsPage })),
)
const ArtifactViewer = lazy(() =>
  import("./artifacts/ArtifactViewer").then((m) => ({ default: m.ArtifactViewer })),
)
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
)
const TasksPage = lazy(() => import("./tasks/TasksPage").then((m) => ({ default: m.TasksPage })))

/**
 * Suspense boundary for one lazily imported route. It sits inside the shell
 * (the route element is the `Outlet` content), so navigating to a lazy route
 * keeps the sidebar and app bar mounted and only the content area waits.
 */
function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>
}

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
          <CompletionProvider>
            <AppShell />
          </CompletionProvider>
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

/** Placeholder while a lazily imported route chunk is in flight. */
function RouteFallback() {
  return (
    <div data-testid="route-loading" className="flex min-h-0 flex-1 items-center justify-center">
      <span className="loading loading-spinner loading-md" aria-hidden="true" />
    </div>
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
        <Route
          path="/search"
          element={
            <LazyRoute>
              <SearchPage />
            </LazyRoute>
          }
        />
        <Route
          path="/c/:sessionId"
          element={
            <LazyRoute>
              <ChatPage />
            </LazyRoute>
          }
        />
        <Route
          path="/c/:sessionId/:messageId"
          element={
            <LazyRoute>
              <ChatPage />
            </LazyRoute>
          }
        />
        <Route
          path="/code"
          element={
            <LazyRoute>
              <CodeRoute />
            </LazyRoute>
          }
        />
        <Route
          path="/code/*"
          element={
            <LazyRoute>
              <CodeRoute />
            </LazyRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <LazyRoute>
              <SettingsPage />
            </LazyRoute>
          }
        />
        <Route
          path="/tasks"
          element={
            <LazyRoute>
              <TasksPage />
            </LazyRoute>
          }
        />
        <Route
          path="/apps"
          element={
            <LazyRoute>
              <AppsRoute />
            </LazyRoute>
          }
        />
        <Route
          path="/artifacts"
          element={
            <ArtifactsRoute>
              <LazyRoute>
                <ArtifactsPage />
              </LazyRoute>
            </ArtifactsRoute>
          }
        />
        <Route
          path="/artifacts/:id"
          element={
            <ArtifactsRoute>
              <LazyRoute>
                <ArtifactViewer />
              </LazyRoute>
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
