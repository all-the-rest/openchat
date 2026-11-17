import { useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { ApiError } from "../api/client"
import { useAuth } from "../auth/provider"
import { LocaleSelect, ThemeToggle } from "../components/controls"
import { useT } from "../i18n/provider"

/**
 * Returns the requested same-origin path from a redirect state, or `null`.
 * Only absolute single-slash paths are accepted: `//evil.example` (and any
 * non-string) is treated as hostile and falls back to the landing page.
 */
export function safeRedirectPath(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null
  const from = (state as { from?: unknown }).from
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) return null
  return from
}

export function LoginPage() {
  const t = useT()
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<"invalid" | "failed" | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length === 0 || pending) return

    setPending(true)
    setError(null)
    try {
      await auth.signIn(password)
      navigate(safeRedirectPath(location.state) ?? "/", { replace: true })
    } catch (failure) {
      const unauthorized =
        failure instanceof ApiError &&
        (failure.status === 401 ||
          failure.code === "invalid_credentials" ||
          failure.code === "invalid_password")
      setError(unauthorized ? "invalid" : "failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-app text-base-content">
      <div className="flex justify-end gap-2 p-4">
        <LocaleSelect />
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pb-20">
        <form
          onSubmit={(event) => void submit(event)}
          className="w-full max-w-sm rounded-card border border-subtle bg-surface p-6 shadow-md"
        >
          <h1 className="text-xl font-semibold">{t("auth.loginTitle")}</h1>
          <p className="mt-1 text-sm text-muted">{t("auth.loginDescription")}</p>

          <label htmlFor="login-password" className="mt-5 block text-sm font-medium">
            {t("auth.passwordLabel")}
          </label>
          <input
            id="login-password"
            data-testid="login-password"
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("auth.passwordPlaceholder")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            className="input input-bordered mt-1 w-full"
          />

          {error ? (
            <p id="login-error" role="alert" className="mt-2 text-sm text-error">
              {t(error === "invalid" ? "auth.invalidPassword" : "auth.loginFailed")}
            </p>
          ) : null}

          <button
            type="submit"
            data-testid="login-submit"
            disabled={password.length === 0 || pending}
            className="btn btn-primary mt-5 w-full"
          >
            {pending ? t("auth.signingIn") : t("auth.signIn")}
          </button>
        </form>
      </div>
    </main>
  )
}
