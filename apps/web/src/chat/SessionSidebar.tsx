import { useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { useAuth } from "../auth/provider"
import { AppsIcon, ArtifactsIcon, MemoryIcon, PlusIcon, SearchIcon, TasksIcon } from "../components/icons"
import { LocaleSelect, ThemeToggle } from "../components/controls"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { relativeTime } from "../lib/format"
import { useSessions } from "./sessions"

export function SessionSidebar({
  onNavigate,
  appsAvailable = false,
  artifactsAvailable = false,
}: {
  onNavigate?: () => void
  /** From `/api/info`; the entry stays hidden when the host has no app surface. */
  appsAvailable?: boolean
  /** From `/api/info`; hidden and inert when artifact storage is not configured. */
  artifactsAvailable?: boolean
}) {
  const t = useT()
  const { locale } = useI18n()
  const auth = useAuth()
  const navigate = useNavigate()
  const { sessions, loading, failed, create } = useSessions()
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)

  const startNewChat = async () => {
    if (creating) return
    setCreating(true)
    setCreateFailed(false)
    try {
      const session = await create()
      onNavigate?.()
      navigate(`/c/${session.id}`)
    } catch {
      setCreateFailed(true)
    } finally {
      setCreating(false)
    }
  }

  const signOut = async () => {
    await auth.signOut()
    navigate("/login", { replace: true })
  }

  return (
    <aside
      id="app-sidebar"
      className="flex h-dvh w-[340px] max-w-[85vw] flex-col border-e border-subtle bg-sidebar"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("app.name")}</span>
        <span className="text-xs text-muted">{auth.user}</span>
      </div>

      <div className="px-3">
        <button
          type="button"
          data-testid="new-chat"
          onClick={() => void startNewChat()}
          disabled={creating}
          className="btn btn-primary btn-sm w-full justify-start gap-2"
        >
          <PlusIcon className="size-4" />
          {t("nav.newChat")}
        </button>
      </div>

      {createFailed ? (
        <div className="px-3 pt-2">
          <ErrorBanner
            message={t("session.createFailed")}
            onDismiss={() => setCreateFailed(false)}
          />
        </div>
      ) : null}

      <nav aria-label={t("nav.main")} className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          <NavLink
            to="/tasks"
            data-testid="nav-tasks"
            onClick={() => onNavigate?.()}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-row px-2 py-1.5 text-sm ${
                isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
              }`
            }
          >
            <TasksIcon className="size-4" />
            {t("tasks.title")}
          </NavLink>
          <NavLink
            to="/memory"
            data-testid="nav-memory"
            onClick={() => onNavigate?.()}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-row px-2 py-1.5 text-sm ${
                isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
              }`
            }
          >
            <MemoryIcon className="size-4" />
            {t("memory.title")}
          </NavLink>
          <NavLink
            to="/search?scope=all"
            data-testid="nav-search"
            onClick={() => onNavigate?.()}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-row px-2 py-1.5 text-sm ${
                isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
              }`
            }
          >
            <SearchIcon className="size-4" />
            {t("nav.search")}
          </NavLink>
          {appsAvailable ? (
            <NavLink
              to="/apps"
              data-testid="nav-apps"
              onClick={() => onNavigate?.()}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-row px-2 py-1.5 text-sm ${
                  isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
                }`
              }
            >
              <AppsIcon className="size-4" />
              {t("nav.apps")}
            </NavLink>
          ) : null}
          {artifactsAvailable ? (
            <NavLink
              to="/artifacts"
              data-testid="nav-artifacts"
              onClick={() => onNavigate?.()}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-row px-2 py-1.5 text-sm ${
                  isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
                }`
              }
            >
              <ArtifactsIcon className="size-4" />
              {t("nav.artifacts")}
            </NavLink>
          ) : null}
        </div>
        <h2 className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
          {t("nav.chats")}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <p className="px-2 py-1 text-xs text-muted">{t("session.loading")}</p>
          ) : failed ? (
            <p className="px-2 py-1 text-xs text-error">{t("session.loadFailed")}</p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">{t("session.empty")}</p>
          ) : (
            <ul aria-label={t("session.listLabel")} className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <NavLink
                    to={`/c/${session.id}`}
                    data-testid="session-item"
                    onClick={() => onNavigate?.()}
                    className={({ isActive }) =>
                      `flex flex-col rounded-row px-2 py-1.5 text-sm ${
                        isActive
                          ? "bg-selected text-base-content"
                          : "text-secondary hover:bg-hover"
                      }`
                    }
                  >
                    <span className="truncate">{session.title || t("session.untitled")}</span>
                    <span className="text-xs text-muted">
                      {relativeTime(session.updated, locale)}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      <div className="flex items-center gap-2 border-t border-subtle p-3">
        <LocaleSelect />
        <ThemeToggle />
        <span className="flex-1" />
        <button type="button" onClick={() => void signOut()} className="btn btn-ghost btn-sm">
          {t("auth.signOut")}
        </button>
      </div>
    </aside>
  )
}
