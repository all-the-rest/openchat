import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { AuthProvider, useAuth } from "./auth/provider"
import { AppShell } from "./components/AppShell"
import { EventStreamProvider } from "./api/events"
import { SessionsProvider } from "./chat/sessions"
import { I18nProvider, useT } from "./i18n/provider"
import { ChatPage } from "./pages/ChatPage"
import { LandingPage } from "./pages/LandingPage"
import { LoginPage } from "./pages/LoginPage"
import { ThemeProvider } from "./theme/provider"

function ProtectedShell() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return (
    <SessionsProvider>
      <EventStreamProvider>
        <AppShell />
      </EventStreamProvider>
    </SessionsProvider>
  )
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
        <Route path="/" element={<LandingPage />} />
        <Route path="/c/:sessionId" element={<ChatPage />} />
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
