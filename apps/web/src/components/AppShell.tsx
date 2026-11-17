import { useEffect, useRef, useState } from "react"
import { Outlet } from "react-router-dom"
import { SidebarToggle } from "../components/controls"
import { useT } from "../i18n/provider"
import { SessionSidebar } from "../chat/SessionSidebar"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function AppShell() {
  const t = useT()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)

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
    <div className="flex h-dvh overflow-hidden bg-app text-base-content">
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-scrim lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div
        ref={drawerRef}
        role={sidebarOpen ? "dialog" : undefined}
        aria-modal={sidebarOpen ? true : undefined}
        aria-label={sidebarOpen ? t("session.listLabel") : undefined}
        className={`fixed inset-y-0 start-0 z-40 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SessionSidebar onNavigate={() => setSidebarOpen(false)} />
      </div>

      <div
        data-testid="app-content"
        inert={sidebarOpen}
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-2 lg:hidden">
          <SidebarToggle
            ref={triggerRef}
            open={sidebarOpen}
            onOpen={() => setSidebarOpen(true)}
          />
          <span className="truncate text-sm font-semibold">{t("app.name")}</span>
        </div>

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
    </div>
  )
}
