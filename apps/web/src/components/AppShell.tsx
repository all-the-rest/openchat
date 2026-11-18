import { useCallback, useEffect, useRef, useState } from "react"
import { Link, Outlet } from "react-router-dom"
import { AppBarMenu } from "../components/AppBarMenu"
import { SidebarToggle } from "../components/controls"
import { HostStatusBanner } from "../components/HostStatusBanner"
import { InstallHint } from "../components/InstallHint"
import { OfflineBanner } from "../components/OfflineBanner"
import { UpdateNotice } from "../components/UpdateNotice"
import { SearchIcon, SettingsIcon } from "../components/icons"
import { useT } from "../i18n/provider"
import { useMediaQuery } from "../lib/useMediaQuery"
import { SessionSidebar } from "../chat/SessionSidebar"
import { CommandPalette } from "../palette/CommandPalette"
import { PaletteChatProvider } from "../palette/current-chat"
import { SurfaceSwitch } from "../code/SurfaceSwitch"
import { useSurface } from "../code/SurfaceProvider"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Desktop layout breakpoint, matching Tailwind's `lg` (spec 08). */
const WIDE_QUERY = "(min-width: 1024px)"

export function AppShell() {
  const t = useT()
  const { surface, appsAvailable, artifactsAvailable } = useSurface()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteNotice, setPaletteNotice] = useState("")
  const wide = useMediaQuery(WIDE_QUERY)
  const drawerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const paletteTriggerRef = useRef<HTMLButtonElement>(null)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)

  // The Code surface owns the full width (spec 13): no chat sidebar, no app
  // bar — its own slim bar carries the switch.
  const onCode = surface === "code"

  useEffect(() => {
    if (onCode) setSidebarOpen(false)
  }, [onCode])

  // The drawer is off-canvas only below the wide breakpoint. While it is closed
  // there its content is inert and unmounted, so it cannot be tabbed into.
  const drawerHidden = !wide && !sidebarOpen

  // `Ctrl/Cmd+K` toggles the palette from anywhere in the protected shell; the
  // opener is remembered so closing returns focus to it once the page behind
  // the dialog is no longer inert.
  const openPalette = useCallback(() => {
    const active = document.activeElement
    paletteReturnFocus.current =
      active instanceof HTMLElement && active !== document.body ? active : paletteTriggerRef.current
    // Two modal layers would fight over focus; the drawer closes first.
    setSidebarOpen(false)
    setPaletteOpen(true)
  }, [])

  const closePalette = useCallback(() => setPaletteOpen(false), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return
      event.preventDefault()
      if (paletteOpen) closePalette()
      else openPalette()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [paletteOpen, openPalette, closePalette])

  useEffect(() => {
    if (paletteOpen) return
    const target = paletteReturnFocus.current
    if (!target) return
    paletteReturnFocus.current = null
    target.focus()
  }, [paletteOpen])

  useEffect(() => {
    if (!sidebarOpen) {
      if (restoreFocus.current) {
        restoreFocus.current = false
        triggerRef.current?.focus()
      }
      return
    }

    restoreFocus.current = true
    const drawer = drawerRef.current

    const focusable = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])

    focusable()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setSidebarOpen(false)
        return
      }
      if (event.key !== "Tab") return

      const nodes = focusable()
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }

      const active = document.activeElement
      const inside = drawer !== null && active instanceof Node && drawer.contains(active)

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

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [sidebarOpen])

  return (
    <PaletteChatProvider>
      <div className="flex h-dvh overflow-hidden bg-app text-base-content">
        {!onCode && sidebarOpen ? (
          <div
            className="fixed inset-0 z-30 bg-scrim lg:hidden"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        {onCode ? null : (
          <div
            ref={drawerRef}
            data-testid="app-drawer"
            role={sidebarOpen ? "dialog" : undefined}
            aria-modal={sidebarOpen ? true : undefined}
            aria-label={sidebarOpen ? t("session.listLabel") : undefined}
            inert={drawerHidden || paletteOpen}
            className={`fixed inset-y-0 start-0 z-40 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            {wide || sidebarOpen ? (
              <SessionSidebar
                onNavigate={() => setSidebarOpen(false)}
                appsAvailable={appsAvailable === true}
                artifactsAvailable={artifactsAvailable === true}
              />
            ) : null}
          </div>
        )}

        <div
          data-testid="app-content"
          inert={sidebarOpen && !wide ? true : paletteOpen}
          className="flex min-w-0 flex-1 flex-col"
        >
          {onCode ? null : (
            <div
              role="banner"
              data-testid="app-bar"
              className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-2"
            >
              <SidebarToggle
                ref={triggerRef}
                open={sidebarOpen}
                onOpen={() => setSidebarOpen(true)}
                className="lg:hidden"
              />
              {wide ? <SurfaceSwitch /> : null}
              {/* The desktop sidebar already shows the name; below `lg` it is the
                  only place it appears, and the menu trigger must not wrap. */}
              <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold lg:hidden">
                {t("app.name")}
              </span>
              <button
                type="button"
                ref={paletteTriggerRef}
                data-testid="palette-open"
                onClick={openPalette}
                aria-label={t("palette.open")}
                title={t("palette.open")}
                aria-keyshortcuts="Control+K Meta+K"
                className="btn btn-ghost btn-sm btn-square"
              >
                <SearchIcon className="size-5" />
              </button>
              <Link
                to="/settings"
                data-testid="app-settings"
                aria-label={t("nav.settings")}
                title={t("nav.settings")}
                className="btn btn-ghost btn-sm btn-square"
              >
                <SettingsIcon className="size-5" />
              </Link>
              <AppBarMenu />
            </div>
          )}

          {/* PWA shell state sits on every protected route, directly under the
              bar (or at the top on the Code surface): connection first, then the
              host, then the deployment and install notices. */}
          <OfflineBanner />
          <HostStatusBanner />
          <UpdateNotice />
          <InstallHint />

          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-row focus:bg-elevated focus:px-3 focus:py-2 focus:text-sm"
          >
            {t("nav.skipToContent")}
          </a>

          <main id="main-content" className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </main>
        </div>

        <CommandPalette open={paletteOpen} onClose={closePalette} onNotice={setPaletteNotice} />
        <span role="status" aria-live="polite" data-testid="palette-status" className="sr-only">
          {paletteNotice}
        </span>
      </div>
    </PaletteChatProvider>
  )
}
