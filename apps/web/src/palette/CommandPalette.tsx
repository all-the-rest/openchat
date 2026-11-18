import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { useNavigate } from "react-router-dom"
import { CloseIcon, SearchIcon } from "../components/icons"
import { useSessions } from "../chat/sessions"
import { useI18n, useT } from "../i18n/provider"
import { copyText } from "../lib/clipboard"
import { relativeTime } from "../lib/format"
import { useTheme } from "../theme/provider"
import { usePaletteChat } from "./current-chat"
import { composeItems, edgeActive, nextActive, type PaletteItem } from "./items"
import { optionID, PaletteOption, PaletteSection } from "./PaletteOption"
import { usePaletteChats } from "./usePaletteChats"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Announced by the shell's live region, e.g. a copy confirmation. */
  onNotice: (message: string) => void
}

/**
 * The global command palette (spec 02, spec 09). One combobox drives both
 * actions and chat search; the input keeps focus and `aria-activedescendant`
 * names the highlighted option, so a screen reader hears each move.
 *
 * The dialog is modal while open: the shell inerts the page behind it, `Tab`
 * stays between the input and the close button, and `Escape` closes it (the
 * shell then returns focus to the opener). There is no permanent trap.
 */
export function CommandPalette({ open, onClose, onNotice }: CommandPaletteProps) {
  const t = useT()
  const { locale, setLocale } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const { sessions, create } = useSessions()
  const navigate = useNavigate()
  const current = usePaletteChat()

  const [query, setQuery] = useState("")
  const [activeID, setActiveID] = useState<string | null>(null)
  const [createFailed, setCreateFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const { status, hits } = usePaletteChats(query)

  const actions = useMemo<PaletteItem[]>(
    () => [
      { id: "new-chat", kind: "action", action: "newChat", label: t("palette.action.newChat") },
      { id: "go-chat", kind: "action", action: "chat", label: t("palette.action.chat") },
      { id: "go-settings", kind: "action", action: "settings", label: t("palette.action.settings") },
      { id: "go-apps", kind: "action", action: "apps", label: t("palette.action.apps") },
      {
        id: "go-artifacts",
        kind: "action",
        action: "artifacts",
        label: t("palette.action.artifacts"),
      },
      { id: "go-code", kind: "action", action: "code", label: t("palette.action.code") },
      {
        id: "toggle-theme",
        kind: "action",
        action: "theme",
        label: theme === "dark" ? t("theme.toggleToLight") : t("theme.toggleToDark"),
      },
      {
        id: "switch-language",
        kind: "action",
        action: "language",
        label: t("palette.action.language", {
          language: t(locale === "en" ? "language.de" : "language.en"),
        }),
      },
      {
        id: "copy-answer",
        kind: "action",
        action: "copyAnswer",
        label: t("palette.action.copyAnswer"),
        hint: current.lastAnswer ? undefined : t("palette.copyUnavailable"),
        disabled: current.lastAnswer === null,
      },
    ],
    [t, theme, locale, current.lastAnswer],
  )

  const recents = useMemo(
    () =>
      sessions.map((session) => ({
        sessionID: session.id,
        title: session.title || t("session.untitled"),
        updated: session.updated,
        snippet: relativeTime(session.updated, locale),
      })),
    [sessions, t, locale],
  )

  const candidates = useMemo(
    () =>
      hits
        .filter((hit) => typeof hit.sessionID === "string" && hit.sessionID.length > 0)
        .map((hit) => ({
          sessionID: hit.sessionID ?? "",
          title: hit.title || t("session.untitled"),
          snippet: hit.snippet,
        })),
    [hits, t],
  )

  const items = useMemo(
    () => composeItems(query, actions, candidates, recents),
    [query, actions, candidates, recents],
  )
  const actionItems = items.filter((item) => item.kind === "action")
  const chatItems = items.filter((item) => item.kind === "chat")
  const itemsKey = items.map((item) => `${item.id}:${item.disabled ? "1" : "0"}`).join("|")
  const firstEnabledID = items.find((item) => !item.disabled)?.id ?? null

  // A fresh query, or a closed palette, starts at the first runnable option.
  useEffect(() => {
    setActiveID(firstEnabledID)
  }, [itemsKey, firstEnabledID, open])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setCreateFailed(false)
    }
  }, [open])

  useEffect(() => {
    if (activeID === null) return
    document.getElementById(optionID(activeID))?.scrollIntoView?.({ block: "nearest" })
  }, [activeID])

  const run = async (item: PaletteItem) => {
    if (item.disabled) return
    if (item.kind === "chat" && item.sessionID) {
      onClose()
      navigate(`/c/${encodeURIComponent(item.sessionID)}`)
      return
    }
    switch (item.action) {
      case "newChat":
        try {
          const session = await create()
          onClose()
          navigate(`/c/${session.id}`)
        } catch {
          setCreateFailed(true)
        }
        return
      case "chat":
        onClose()
        navigate("/")
        return
      case "settings":
        onClose()
        navigate("/settings")
        return
      case "apps":
        onClose()
        navigate("/apps")
        return
      case "artifacts":
        onClose()
        navigate("/artifacts")
        return
      case "code":
        onClose()
        navigate("/code")
        return
      case "theme":
        toggleTheme()
        onClose()
        return
      case "language":
        setLocale(locale === "en" ? "de" : "en")
        onClose()
        return
      case "copyAnswer": {
        const answer = current.lastAnswer
        if (!answer) return
        const copied = await copyText(answer)
        onClose()
        onNotice(copied ? t("palette.copied") : t("palette.copyFailed"))
        return
      }
      default:
        return
    }
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>, dialog: HTMLElement) => {
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }
    const active = document.activeElement
    const inside = active instanceof Node && dialog.contains(active)
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
      return
    }
    const dialog = dialogRef.current
    if (dialog && event.key === "Tab") {
      trapFocus(event, dialog)
      return
    }
    if (event.target !== inputRef.current) return

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setActiveID((currentID) => nextActive(items, currentID, event.key === "ArrowDown" ? 1 : -1))
    } else if (event.key === "Home") {
      event.preventDefault()
      setActiveID(edgeActive(items, false))
    } else if (event.key === "End") {
      event.preventDefault()
      setActiveID(edgeActive(items, true))
    } else if (event.key === "Enter") {
      const active = items.find((item) => item.id === activeID)
      if (!active || active.disabled) return
      event.preventDefault()
      void run(active)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        data-testid="command-palette"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-subtle bg-elevated shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-subtle px-3">
          <SearchIcon className="size-4 shrink-0 text-muted" />
          <label htmlFor="palette-input" className="sr-only">
            {t("palette.label")}
          </label>
          <input
            ref={inputRef}
            id="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeID ? optionID(activeID) : undefined}
            data-testid="palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("palette.placeholder")}
            autoComplete="off"
            className="w-full bg-transparent py-3 text-sm placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("palette.close")}
            title={t("palette.close")}
            className="btn btn-ghost btn-xs btn-square"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        {createFailed ? (
          <p role="alert" className="border-b border-subtle px-3 py-2 text-xs text-error">
            {t("session.createFailed")}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <ul id="palette-list" role="listbox" aria-label={t("palette.label")} data-testid="palette-list">
            {actionItems.length > 0 ? <PaletteSection>{t("palette.actions")}</PaletteSection> : null}
            {actionItems.map((item) => (
              <PaletteOption
                key={item.id}
                item={item}
                active={item.id === activeID}
                onActivate={() => {
                  if (!item.disabled) setActiveID(item.id)
                }}
                onRun={() => void run(item)}
              />
            ))}

            {chatItems.length > 0 ? (
              <PaletteSection>
                {query.trim().length === 0 ? t("palette.recent") : t("palette.chats")}
              </PaletteSection>
            ) : null}
            {chatItems.map((item) => (
              <PaletteOption
                key={item.id}
                item={item}
                active={item.id === activeID}
                onActivate={() => setActiveID(item.id)}
                onRun={() => void run(item)}
              />
            ))}
          </ul>

          {query.trim().length > 0 && status === "loading" ? (
            <p className="px-3 py-2 text-xs text-muted">{t("palette.searching")}</p>
          ) : null}
          {query.trim().length > 0 && status === "error" ? (
            <p role="alert" className="px-3 py-2 text-xs text-error">
              {t("palette.searchFailed")}
            </p>
          ) : null}
          {query.trim().length > 0 && status === "ready" && chatItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{t("palette.noResults", { query: query.trim() })}</p>
          ) : null}
          {query.trim().length === 0 && chatItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{t("session.empty")}</p>
          ) : null}
        </div>

        <p className="border-t border-subtle px-3 py-2 text-xs text-muted">{t("palette.hint")}</p>
      </div>
    </div>
  )
}
