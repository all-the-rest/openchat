import { useEffect, useRef } from "react"
import { useT } from "../i18n/provider"
import { CloseIcon } from "./icons"

/**
 * Small modal overlay listing the shell's keyboard shortcuts (spec 09). It is
 * opened with Ctrl/Cmd+/ from the shell, owns focus while open and restores it
 * to the opener when it closes.
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const lastFocused = useRef<HTMLElement | null>(null)

  // The shell makes `app-content` inert in the same commit that opens this
  // dialog, which blurs the opener to <body> before passive effects run. Track
  // focus continuously so we can restore to the real opener.
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const el = event.target
      if (el instanceof HTMLElement && el !== document.body && !dialogRef.current?.contains(el)) {
        lastFocused.current = el
      }
    }
    document.addEventListener("focusin", track)
    return () => document.removeEventListener("focusin", track)
  }, [])

  useEffect(() => {
    if (!open) return
    previousFocus.current = lastFocused.current
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      // The close button is the only focusable control; contain Tab so focus
      // cannot escape to the skip link (a sibling outside the inert app shell).
      if (event.key === "Tab" && closeRef.current) {
        event.preventDefault()
        closeRef.current.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) return
    const target = previousFocus.current
    if (!target) return
    previousFocus.current = null
    if (target.isConnected) target.focus()
  }, [open])

  if (!open) return null

  const rows = [
    { keys: t("shortcuts.keys.palette"), label: t("shortcuts.list.palette") },
    { keys: t("shortcuts.keys.newChat"), label: t("shortcuts.list.newChat") },
    { keys: t("shortcuts.keys.surface"), label: t("shortcuts.list.surface") },
    { keys: t("shortcuts.keys.escape"), label: t("shortcuts.list.escape") },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        data-testid="shortcuts-help"
        className="w-full max-w-md rounded-card border border-subtle bg-elevated p-4 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="shortcuts-help-title" className="text-base font-semibold">
            {t("shortcuts.title")}
          </h2>
          <button
            type="button"
            ref={closeRef}
            data-testid="shortcuts-help-close"
            onClick={onClose}
            aria-label={t("shortcuts.close")}
            className="btn btn-ghost btn-sm btn-square"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
        <dl className="mt-3 flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3">
              <dt className="text-sm text-secondary">{row.label}</dt>
              <dd className="text-sm text-muted">
                <kbd className="rounded-row border border-subtle px-1.5 py-0.5">{row.keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
