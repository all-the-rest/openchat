import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useSessions } from "../chat/sessions"
import { SurfaceSwitch } from "../code/SurfaceSwitch"
import { useSurface } from "../code/SurfaceProvider"
import { useT } from "../i18n/provider"
import { useMediaQuery } from "../lib/useMediaQuery"
import { AppsIcon, ArtifactsIcon, MoreIcon, PlusIcon, SearchIcon } from "./icons"

/** Desktop layout breakpoint, matching the shell's drawer and Tailwind's `lg`. */
const WIDE_QUERY = "(min-width: 1024px)"

const ITEM = [
  "flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-start text-sm",
  "text-secondary hover:bg-hover focus-visible:bg-hover",
].join(" ")

const MENU_ITEM = '[role="menuitem"]'

/**
 * The app bar's overflow menu (spec 02, spec 13). Below `lg` the Chat | Code
 * switch has no room in the bar, so the menu carries it together with the
 * navigation entries the drawer used to hold alone. The drawer keeps the
 * session list; this menu never duplicates it.
 *
 * It is a menu, not a dialog: no focus trap, `Escape` returns focus to the
 * trigger and a click outside or a navigation closes it.
 */
export function AppBarMenu({ className = "" }: { className?: string }) {
  const t = useT()
  const wide = useMediaQuery(WIDE_QUERY)
  const { configured, appsAvailable, artifactsAvailable } = useSurface()
  const { create } = useSessions()
  const navigate = useNavigate()
  const location = useLocation()

  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelID = useId()

  const route = `${location.pathname}${location.search}`
  const previousRoute = useRef(route)

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setCreateFailed(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Any navigation — a menu link, the surface switch, a browser Back — ends
  // the menu. The initial route is skipped so a reload cannot close it early.
  useEffect(() => {
    if (previousRoute.current === route) return
    previousRoute.current = route
    setOpen(false)
    setCreateFailed(false)
  }, [route])

  // Pointer-down rather than click: the menu closes before a target outside
  // receives the event, so the interaction the owner aimed at is not stolen.
  // `Escape` is captured at the document because focus may have been tabbed
  // out of the panel; it always hands focus back to the trigger.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close(true)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, close])

  // Opening by click or `ArrowDown` moves focus to the first item, per the
  // ARIA menu pattern. The trigger is the only way back out without choosing.
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus()
  }, [open])

  // Growing past `lg` unmounts the menu; do not restore it open when the
  // window shrinks again.
  useEffect(() => {
    if (wide) setOpen(false)
  }, [wide])

  const startNewChat = useCallback(async () => {
    if (creating) return
    setCreating(true)
    setCreateFailed(false)
    try {
      const session = await create()
      setOpen(false)
      navigate(`/c/${session.id}`)
    } catch {
      setCreateFailed(true)
    } finally {
      setCreating(false)
    }
  }, [create, creating, navigate])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return

    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [],
    )
    const active = document.activeElement
    if (items.length === 0 || !(active instanceof HTMLElement)) return
    const index = items.indexOf(active)
    // Inside the segmented surface control the arrow keys belong to the
    // buttons, not to the menu items around them.
    if (index === -1) return

    event.preventDefault()
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % items.length
        : event.key === "ArrowUp"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : items.length - 1
    items[next]?.focus()
  }

  // Below `lg` the sidebar is a drawer, so this is the only app bar menu.
  if (wide) return null

  return (
    <div className={`relative ${className}`.trim()} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        data-testid="app-bar-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("menu.trigger")}
        title={t("menu.trigger")}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className="btn btn-ghost btn-sm btn-square"
      >
        <MoreIcon className="size-4" />
      </button>

      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="menu"
          aria-label={t("menu.label")}
          data-testid="app-bar-menu-panel"
          className="absolute end-0 top-full z-50 mt-1 w-60 rounded-row border border-subtle bg-elevated p-1 shadow-lg"
        >
          {configured === true ? (
            <SurfaceSwitch className="m-1 w-[calc(100%_-_0.5rem)]" />
          ) : null}

          <Link
            to="/search?scope=all"
            role="menuitem"
            data-testid="menu-search"
            onClick={() => close(false)}
            className={ITEM}
          >
            <SearchIcon className="size-4 shrink-0" />
            {t("nav.search")}
          </Link>

          {appsAvailable === true ? (
            <Link
              to="/apps"
              role="menuitem"
              data-testid="menu-apps"
              onClick={() => close(false)}
              className={ITEM}
            >
              <AppsIcon className="size-4 shrink-0" />
              {t("nav.apps")}
            </Link>
          ) : null}

          {artifactsAvailable === true ? (
            <Link
              to="/artifacts"
              role="menuitem"
              data-testid="menu-artifacts"
              onClick={() => close(false)}
              className={ITEM}
            >
              <ArtifactsIcon className="size-4 shrink-0" />
              {t("nav.artifacts")}
            </Link>
          ) : null}

          <button
            type="button"
            role="menuitem"
            data-testid="menu-new-chat"
            disabled={creating}
            onClick={() => void startNewChat()}
            className={ITEM}
          >
            <PlusIcon className="size-4 shrink-0" />
            {t("nav.newChat")}
          </button>

          {createFailed ? (
            <p role="alert" className="px-2 pb-1 pt-0.5 text-xs text-error">
              {t("session.createFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
