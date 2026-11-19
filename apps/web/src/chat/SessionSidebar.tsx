import { useMemo, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { useAuth } from "../auth/provider"
import {
  AppsIcon,
  ArtifactsIcon,
  BrainIcon,
  ChevronDownIcon,
  PlusIcon,
  SearchIcon,
  TasksIcon,
} from "../components/icons"
import { LocaleSelect, ThemeToggle } from "../components/controls"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { relativeTime } from "../lib/format"
import {
  groupSessions,
  readExpandedSessions,
  writeExpandedSessions,
} from "./session-groups"
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
  const [filter, setFilter] = useState("")
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)
  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => readExpandedSessions())

  const toggleGroup = (sessionID: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(sessionID)) next.delete(sessionID)
      else next.add(sessionID)
      writeExpandedSessions(next)
      return next
    })
  }

  // The sidebar stays the title surface: the palette is the global entry, this
  // filters the already loaded list locally and never queries the host. A
  // group stays visible when the parent or one of its children matches, so a
  // matching subagent chat is reachable through its parent.
  const needle = filter.trim().toLowerCase()
  const matchesTitle = (session: { title: string }) =>
    (session.title || t("session.untitled")).toLowerCase().includes(needle)
  const visibleGroups = groups.filter(
    (group) => matchesTitle(group.session) || group.children.some(matchesTitle),
  )

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
            <BrainIcon className="size-4" />
            {t("nav.memory")}
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
        <div className="px-2 pb-2">
          <label htmlFor="session-filter" className="sr-only">
            {t("session.filterLabel")}
          </label>
          <input
            id="session-filter"
            type="search"
            data-testid="session-filter"
            maxLength={100}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("session.filterPlaceholder")}
            className="w-full rounded-row border border-subtle bg-surface px-2 py-1 text-sm placeholder:text-muted"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <p className="px-2 py-1 text-xs text-muted">{t("session.loading")}</p>
          ) : failed ? (
            <p className="px-2 py-1 text-xs text-error">{t("session.loadFailed")}</p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">{t("session.empty")}</p>
          ) : visibleGroups.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">{t("session.noMatch")}</p>
          ) : (
            <ul aria-label={t("session.listLabel")} className="flex flex-col gap-0.5">
              {visibleGroups.map(({ session, children, orphan }) => {
                const isExpanded = expanded.has(session.id)
                const listID = `session-children-${session.id}`
                const title = session.title || t("session.untitled")
                const linkClass = ({ isActive }: { isActive: boolean }) =>
                  `flex min-w-0 flex-1 flex-col rounded-row px-2 py-1.5 text-sm ${
                    isActive ? "bg-selected text-base-content" : "text-secondary hover:bg-hover"
                  }`

                return (
                  <li key={session.id} data-testid="session-group">
                    <div className="flex items-stretch gap-0.5">
                      <NavLink
                        to={`/c/${session.id}`}
                        data-testid="session-item"
                        data-session-id={session.id}
                        onClick={() => onNavigate?.()}
                        className={linkClass}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {orphan ? (
                            <span
                              data-testid="session-orphan-badge"
                              className="badge badge-ghost badge-xs shrink-0"
                            >
                              {t("session.agentBadge")}
                            </span>
                          ) : null}
                          <span className="truncate">{title}</span>
                        </span>
                        <span className="text-xs text-muted">
                          {relativeTime(session.updated, locale)}
                        </span>
                      </NavLink>
                      {children.length > 0 ? (
                        <button
                          type="button"
                          data-testid="session-children-toggle"
                          data-session-id={session.id}
                          aria-expanded={isExpanded}
                          aria-controls={listID}
                          aria-label={t("session.toggleChildren", { count: children.length })}
                          title={t("session.toggleChildren", { count: children.length })}
                          onClick={() => toggleGroup(session.id)}
                          className="btn btn-ghost btn-xs my-0.5 shrink-0 gap-0.5 px-1.5"
                        >
                          <span aria-hidden="true" className="text-xs tabular-nums">
                            {children.length}
                          </span>
                          <ChevronDownIcon
                            className={`size-3.5 transition-transform ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                      ) : null}
                    </div>
                    {children.length > 0 ? (
                      <ul
                        id={listID}
                        aria-label={t("session.childrenLabel")}
                        data-testid="session-children"
                        hidden={!isExpanded}
                        className={isExpanded ? "mt-0.5 flex flex-col gap-0.5 ps-4" : undefined}
                      >
                        {children.map((child) => (
                          <li key={child.id}>
                            <NavLink
                              to={`/c/${child.id}`}
                              data-testid="session-child"
                              data-session-id={child.id}
                              onClick={() => onNavigate?.()}
                              className={linkClass}
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="badge badge-soft badge-xs shrink-0">
                                  {t("session.agentBadge")}
                                </span>
                                <span className="truncate">
                                  {child.title || t("session.untitled")}
                                </span>
                              </span>
                              <span className="truncate text-xs text-muted">
                                {`${t("session.childOf", { title })} · ${relativeTime(
                                  child.updated,
                                  locale,
                                )}`}
                              </span>
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
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
