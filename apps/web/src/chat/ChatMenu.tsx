import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { Message, ToolStatus } from "@openchat/contracts"
import { DownloadIcon, MoreIcon } from "../components/icons"
import { saveBlob } from "../artifacts/files"
import type { MessageKey } from "../i18n"
import { useT } from "../i18n/provider"
import { buildChatMarkdown, chatFilename } from "./export"

const TOOL_STATUS_KEY: Record<ToolStatus, MessageKey> = {
  queued: "tool.status.queued",
  running: "tool.status.running",
  success: "tool.status.success",
  error: "tool.status.error",
}

const ITEM =
  "flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-start text-sm text-secondary hover:bg-hover focus-visible:bg-hover"

/**
 * The transcript header's session menu (spec 02: rename, pin, archive, delete,
 * export in v1). Only export has a shipped action today; the menu exists so
 * later session actions land in the same, focused place.
 *
 * It is a menu, not a modal: `Escape` closes and returns focus to the trigger.
 * The export reads the loaded transcript, so it needs no server round-trip.
 */
export function ChatMenu({
  title,
  created,
  messages,
  onCompact,
  compactDisabled = false,
}: {
  title: string
  created?: number
  messages: readonly Message[]
  /** Manual compaction; the host rejects it while a run is streaming. */
  onCompact?: () => void
  compactDisabled?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
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

  const download = () => {
    close(false)
    try {
      const markdown = buildChatMarkdown({
        title,
        created,
        messages,
        labels: {
          date: t("chat.export.date"),
          user: t("chat.youSaid"),
          assistant: t("chat.assistantSaid"),
          system: t("chat.export.system"),
          tool: t("chat.export.tool"),
          artifact: t("chat.export.artifact"),
          artifactNote: t("chat.export.artifactNote"),
          untitled: t("session.untitled"),
        },
        toolStatus: (status) => t(TOOL_STATUS_KEY[status]),
      })
      saveBlob(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
        chatFilename(title || t("session.untitled")),
      )
      setNotice(t("chat.downloadDone"))
    } catch {
      // A refused object URL or a blocked download must not fail silently.
      setNotice(t("chat.downloadFailed"))
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        data-testid="chat-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("chat.menuTrigger")}
        title={t("chat.menuTrigger")}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="btn btn-ghost btn-sm btn-square"
      >
        <MoreIcon className="size-4" />
      </button>

      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="menu"
          aria-label={t("chat.menuLabel")}
          data-testid="chat-menu-panel"
          className="absolute end-0 top-full z-50 mt-1 w-56 rounded-row border border-subtle bg-elevated p-1 shadow-lg"
        >
          {onCompact ? (
            <button
              type="button"
              role="menuitem"
              data-testid="compact-now"
              disabled={compactDisabled}
              title={t("chat.compactNowHint")}
              onClick={() => {
                close(false)
                onCompact()
              }}
              className={ITEM}
            >
              {t("chat.compactNow")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid="chat-download"
            onClick={download}
            className={ITEM}
          >
            <DownloadIcon className="size-4 shrink-0" />
            {t("chat.download")}
          </button>
        </div>
      ) : null}

      <span role="status" aria-live="polite" data-testid="chat-menu-status" className="sr-only">
        {notice ?? ""}
      </span>
    </div>
  )
}
