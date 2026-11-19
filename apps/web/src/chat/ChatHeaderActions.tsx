import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { MoreIcon } from "../components/icons"
import { useT } from "../i18n/provider"

/**
 * Narrow-width home for the header's secondary controls (spec 04, spec 09).
 * The title and the session menu stay in the bar; the meter, usage panel and
 * completion pickers move behind this trigger so nothing is dropped at 320 px.
 * It is a labelled group, not a `menu`: its children are pickers and panels,
 * not `menuitem`s. `Escape` restores focus and an outside click closes it.
 */
export function ChatHeaderActions({ children }: { children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelID = useId()

  useEffect(() => {
    if (!open) return
    // Move focus into the panel so keyboard and screen-reader users land in
    // the revealed controls instead of staying on the trigger.
    panelRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div className="relative shrink-0" data-testid="chat-header-actions">
      <button
        type="button"
        ref={triggerRef}
        data-testid="chat-header-more"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("menu.trigger")}
        title={t("menu.trigger")}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-ghost btn-sm btn-square"
      >
        <MoreIcon className="size-4" />
      </button>
      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="group"
          aria-label={t("menu.label")}
          tabIndex={-1}
          data-testid="chat-header-actions-panel"
          className="absolute end-0 top-full z-50 mt-1 flex w-max max-w-[calc(100vw_-_2rem)] flex-col gap-2 overflow-x-auto rounded-row border border-subtle bg-elevated p-2 shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
