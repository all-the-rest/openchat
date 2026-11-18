/**
 * Chat file list and its delete confirmation.
 *
 * Compact by design: the list sits between the chat header and the transcript
 * and only appears once the chat owns a file. Every action is per file; the
 * quota line is the same number the server enforces before a write.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ChatFileInfo, ChatFilesResponse } from "@openchat/contracts"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import type { Locale } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { formatChatFileSize } from "./files"

type LoadStatus = "loading" | "ready" | "error"

function quotaText(
  quota: ChatFilesResponse["quota"],
  locale: Locale,
): { used: string; total: string; percent: number } {
  const used = formatChatFileSize(quota.usedBytes, locale)
  const total = formatChatFileSize(quota.quotaBytes, locale)
  const percent =
    quota.quotaBytes > 0
      ? Math.min(100, Math.round((quota.usedBytes / quota.quotaBytes) * 100))
      : 0
  return { used, total, percent }
}

interface ChatFilesProps {
  sessionID: string
  /** Bumped by the page after an upload or a send to refresh the list. */
  version?: number
}

export function ChatFiles({ sessionID, version = 0 }: ChatFilesProps) {
  const t = useT()
  const { locale } = useI18n()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [data, setData] = useState<ChatFilesResponse | null>(null)
  const [loadedSession, setLoadedSession] = useState(sessionID)
  const [reloadToken, setReloadToken] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<ChatFileInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void api
      .chatFiles(sessionID)
      .then((response) => {
        if (cancelled) return
        setData(response)
        setLoadedSession(sessionID)
        setStatus("ready")
      })
      .catch(() => {
        if (!cancelled) setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [sessionID, reloadToken, version])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    setDeleteFailed(false)
    try {
      await api.deleteChatFile(sessionID, pendingDelete.name)
      if (!alive.current) return
      setPendingDelete(null)
      reload()
    } catch {
      if (alive.current) setDeleteFailed(true)
    } finally {
      if (alive.current) setDeleting(false)
    }
  }

  if (status === "error") {
    return (
      <div className="shrink-0 border-b border-subtle bg-app px-4 py-1.5">
        <div className="mx-auto flex w-full max-w-[768px] items-center gap-2 text-xs text-muted">
          <span>{t("files.loadFailed")}</span>
          <button
            type="button"
            onClick={() => {
              setStatus("loading")
              reload()
            }}
            className="btn btn-ghost btn-xs"
          >
            {t("files.retry")}
          </button>
        </div>
      </div>
    )
  }

  // A session switch keeps the previous response in state for one render; it
  // must never show up under the new chat.
  if (status !== "ready" || !data || loadedSession !== sessionID) return null
  if (data.files.length === 0) return null

  const { used, total, percent } = quotaText(data.quota, locale)

  return (
    <section
      data-testid="chat-files"
      aria-label={t("files.listLabel")}
      className="shrink-0 border-b border-subtle bg-app px-4 py-2"
    >
      <div className="mx-auto flex w-full max-w-[768px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("files.title")}
          </h2>
          <div className="flex min-w-32 flex-1 items-center gap-2">
            <progress
              className="progress progress-primary h-1.5"
              value={data.quota.usedBytes}
              max={data.quota.quotaBytes}
              aria-label={t("files.quotaLabel")}
              data-testid="files-quota"
            />
            <span data-testid="files-quota-text" className="whitespace-nowrap text-xs text-muted">
              {t("files.quota", { used, total, percent })}
            </span>
          </div>
        </div>

        {deleteFailed ? (
          <div className="flex items-center gap-2">
            <ErrorBanner message={t("files.deleteFailed")} />
            <button
              type="button"
              onClick={() => setDeleteFailed(false)}
              className="btn btn-ghost btn-xs"
            >
              {t("files.dismiss")}
            </button>
          </div>
        ) : null}

        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {data.files.map((file) => (
            <li
              key={file.name}
              data-testid="chat-file"
              className="flex items-center gap-2 rounded-row px-1.5 py-1 text-sm hover:bg-hover"
            >
              <span data-testid="chat-file-name" className="min-w-0 flex-1 truncate" title={file.displayName}>
                {file.displayName}
              </span>
              <span className="badge badge-ghost badge-sm shrink-0">
                {t(file.origin === "agent" ? "files.origin.agent" : "files.origin.upload")}
              </span>
              <span className="shrink-0 text-xs text-muted" data-testid="chat-file-size">
                {formatChatFileSize(file.size, locale)}
              </span>
              <a
                href={api.chatFileDownloadUrl(sessionID, file.name)}
                download={file.displayName}
                aria-label={t("files.downloadLabel", { name: file.displayName })}
                className="link link-primary shrink-0 text-xs"
              >
                {t("files.download")}
              </a>
              <button
                type="button"
                onClick={() => {
                  setDeleteFailed(false)
                  setPendingDelete(file)
                }}
                aria-label={t("files.deleteLabel", { name: file.displayName })}
                className="btn btn-ghost btn-xs shrink-0"
              >
                {t("files.delete")}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {pendingDelete ? (
        <div
          className="modal modal-open"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="chat-file-delete-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleting) setPendingDelete(null)
          }}
        >
          <div className="modal-box max-w-sm">
            <h3 id="chat-file-delete-title" className="text-base font-semibold">
              {t("files.deleteTitle")}
            </h3>
            <p className="mt-2 text-sm text-muted">
              {t("files.deleteBody", { name: pendingDelete.displayName })}
            </p>
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm"
                autoFocus
                disabled={deleting}
                onClick={() => setPendingDelete(null)}
              >
                {t("files.deleteCancel")}
              </button>
              <button
                type="button"
                className="btn btn-error btn-sm"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {t("files.deleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
