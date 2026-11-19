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

/** What the open panel shows: the action list, the rename form or a confirm. */
type Mode = "menu" | "rename" | "delete"

/**
 * The transcript header's session menu (spec 02: rename, pin, archive, delete,
 * export in v1). Rename and delete are the shipped session mutations: rename
 * edits the title inline with a cancel, delete asks once before it acts. Export
 * reads the loaded transcript, so it needs no server round-trip.
 *
 * It is a menu, not a modal: `Escape` closes and returns focus to the trigger.
 */
export function ChatMenu({
  title,
  created,
  messages,
  onCompact,
  compactDisabled = false,
  onRename,
  onDelete,
}: {
  title: string
  created?: number
  messages: readonly Message[]
  /** Manual compaction; the host rejects it while a run is streaming. */
  onCompact?: () => void
  compactDisabled?: boolean
  /** Resolves true when the new title was stored; the caller owns the list. */
  onRename?: (title: string) => Promise<boolean>
  /** Resolves true when the chat is gone; the caller navigates away. */
  onDelete?: () => Promise<boolean>
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("menu")
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const panelID = useId()
  const renameID = useId()

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setMode("menu")
    setFailed(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return

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

  // Focus follows the panel state: the first action in the list, the title
  // field while renaming, and the safe Cancel while a delete is confirmed.
  useEffect(() => {
    if (!open) return
    if (mode === "rename") renameRef.current?.focus()
    else if (mode === "delete") cancelRef.current?.focus()
    else panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open, mode])

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

  const startRename = () => {
    setDraft(title)
    setFailed(false)
    setMode("rename")
  }

  const submitRename = async (event: { preventDefault(): void }) => {
    event.preventDefault()
    const next = draft.trim()
    if (busy || next.length === 0 || !onRename) return
    setBusy(true)
    setFailed(false)
    try {
      if (await onRename(next)) {
        close(false)
        setNotice(t("chat.renameDone"))
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (busy || !onDelete) return
    setBusy(true)
    setFailed(false)
    try {
      if (await onDelete()) close(false)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
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
          {mode === "rename" ? (
            <form role="none" onSubmit={submitRename} data-testid="chat-rename-form" className="p-1">
              <label htmlFor={renameID} className="block text-xs text-muted">
                {t("chat.renameLabel")}
              </label>
              <input
                id={renameID}
                ref={renameRef}
                type="text"
                value={draft}
                maxLength={120}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                className="mt-1 w-full rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
              />
              {failed ? (
                <p role="alert" className="mt-1 text-xs text-error">
                  {t("chat.renameFailed")}
                </p>
              ) : null}
              <div className="mt-2 flex gap-1">
                <button
                  type="submit"
                  data-testid="chat-rename-save"
                  disabled={busy || draft.trim().length === 0}
                  className="btn btn-primary btn-xs"
                >
                  {t("chat.renameSave")}
                </button>
                <button
                  type="button"
                  data-testid="chat-rename-cancel"
                  disabled={busy}
                  onClick={() => {
                    setMode("menu")
                    setFailed(false)
                  }}
                  className="btn btn-ghost btn-xs"
                >
                  {t("chat.renameCancel")}
                </button>
              </div>
            </form>
          ) : mode === "delete" ? (
            <div role="none" data-testid="chat-delete-confirm" className="p-1">
              <p className="text-xs">{t("chat.deleteQuestion")}</p>
              <p className="mt-1 truncate text-xs text-muted">{title}</p>
              {failed ? (
                <p role="alert" className="mt-1 text-xs text-error">
                  {t("chat.deleteFailed")}
                </p>
              ) : null}
              <div className="mt-2 flex gap-1">
                <button
                  type="button"
                  data-testid="chat-delete-confirm-button"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                  className="btn btn-error btn-xs"
                >
                  {t("chat.deleteConfirm")}
                </button>
                <button
                  type="button"
                  ref={cancelRef}
                  data-testid="chat-delete-cancel"
                  disabled={busy}
                  onClick={() => {
                    setMode("menu")
                    setFailed(false)
                  }}
                  className="btn btn-ghost btn-xs"
                >
                  {t("chat.deleteCancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {onRename ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chat-rename"
                  onClick={startRename}
                  className={ITEM}
                >
                  {t("chat.rename")}
                </button>
              ) : null}
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
              {onDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chat-delete"
                  onClick={() => {
                    setFailed(false)
                    setMode("delete")
                  }}
                  className={ITEM}
                >
                  {t("chat.delete")}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <span role="status" aria-live="polite" data-testid="chat-menu-status" className="sr-only">
        {notice ?? ""}
      </span>
    </div>
  )
}
