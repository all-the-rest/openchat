import { useEffect, useRef, useState } from "react"
import { MoreIcon } from "../components/icons"
import { useT } from "../i18n/provider"

/**
 * The chat header's action menu. It currently holds the manual compaction; the
 * item is disabled while a run is active, because the host rejects compaction
 * on a streaming session.
 */
export function ChatMenu({
  onCompact,
  disabled,
}: {
  onCompact: () => void
  disabled: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        data-testid="chat-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("chat.menuLabel")}
        title={t("chat.menuLabel")}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-ghost btn-sm btn-square"
      >
        <MoreIcon className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="chat-menu-panel"
          aria-label={t("chat.menuLabel")}
          className="absolute end-0 top-full z-50 mt-1 w-56 rounded-row border border-subtle bg-elevated p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="compact-now"
            disabled={disabled}
            title={t("chat.compactNowHint")}
            onClick={() => {
              setOpen(false)
              onCompact()
            }}
            className="flex w-full items-center rounded-row px-2 py-1.5 text-start text-sm text-secondary hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
          >
            {t("chat.compactNow")}
          </button>
        </div>
      ) : null}
    </div>
  )
}
