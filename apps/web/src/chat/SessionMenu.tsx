import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ChevronDownIcon, DownloadIcon } from "../components/icons"
import { useI18n, useT } from "../i18n/provider"
import type { MessageKey } from "../i18n"
import { buildChatMarkdown, exportFilename } from "./exportChat"
import { downloadText } from "./download"

/** Chat-title menu. Export is the first shipped action; rename/pin/archive/delete follow in a later slice. */
export function SessionMenu({
  title,
  created,
  messages,
}: {
  title: string
  created: number
  messages: readonly import("@openchat/contracts").Message[]
}) {
  const t = useT()
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelID = useId()

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, close])

  const download = () => {
    try {
      const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(created),
      )
      const markdown = buildChatMarkdown({ title, date, messages }, t)
      downloadText(exportFilename(title), markdown)
      setNotice("export.success")
    } catch {
      setNotice("export.failed")
    }
    close(false)
  }

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        data-testid="session-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("export.menuLabel")}
        title={t("export.menuLabel")}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="btn btn-ghost btn-sm gap-1"
      >
        <ChevronDownIcon className="size-4" />
      </button>

      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="menu"
          aria-label={t("export.menuLabel")}
          data-testid="session-menu"
          className="absolute end-0 top-full z-50 mt-1 w-56 rounded-row border border-subtle bg-elevated p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="session-export"
            onClick={download}
            className="flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-start text-sm text-secondary hover:bg-hover focus-visible:bg-hover"
          >
            <DownloadIcon className="size-4 shrink-0" />
            {t("export.action")}
          </button>
        </div>
      ) : null}

      {notice ? (
        <p
          role="status"
          data-testid="export-notice"
          className="absolute end-0 top-full z-50 mt-1 whitespace-nowrap rounded-row border border-subtle bg-elevated px-2 py-1 text-xs text-secondary"
        >
          {t(notice)}
        </p>
      ) : null}
    </div>
  )
}
