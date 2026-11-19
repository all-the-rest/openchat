import type { ChatFileInfo, ChatFileQuota } from "@openchat/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"
import { formatArtifactDate, formatBytes, saveBlob } from "../artifacts/files"
import { DownloadIcon, TrashIcon } from "../components/icons"
import { useI18n, useT } from "../i18n/provider"

type LoadStatus = "loading" | "ready" | "error"
type ActionError = "download" | "delete" | null

export interface ChatFilesProps {
  sessionID: string
}

/**
 * Compact list of the chat's working files. The server owns names, sizes and
 * hashes; the panel only shows the metadata and offers the two actions the v1
 * scope allows: download and a confirmed delete.
 */
export function ChatFiles({ sessionID }: ChatFilesProps) {
  const t = useT()
  const { locale } = useI18n()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [files, setFiles] = useState<ChatFileInfo[]>([])
  const [quota, setQuota] = useState<ChatFileQuota | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError>(null)
  const alive = useRef(true)
  const activeSession = useRef(sessionID)
  activeSession.current = sessionID

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setStatus("loading")
    setActionError(null)
    try {
      const response = await api.chatFiles(sessionID)
      if (!alive.current || activeSession.current !== sessionID) return
      setFiles(response.files)
      setQuota(response.quota)
      setStatus("ready")
    } catch {
      if (!alive.current || activeSession.current !== sessionID) return
      setStatus("error")
    }
  }, [sessionID])

  useEffect(() => {
    setFiles([])
    setQuota(null)
    setPendingDelete(null)
    void load()
  }, [load])

  const download = async (file: ChatFileInfo) => {
    setBusy(file.name)
    setActionError(null)
    try {
      const blob = await api.chatFileDownload(sessionID, file.name)
      if (alive.current) saveBlob(blob, file.displayName)
    } catch {
      if (alive.current) setActionError("download")
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const remove = async (file: ChatFileInfo) => {
    setBusy(file.name)
    setActionError(null)
    try {
      await api.deleteChatFile(sessionID, file.name)
      if (!alive.current) return
      setFiles((current) => current.filter((entry) => entry.name !== file.name))
      setQuota((current) =>
        current
          ? {
              ...current,
              usedBytes: Math.max(0, current.usedBytes - file.size),
              totalUsedBytes: Math.max(0, current.totalUsedBytes - file.size),
            }
          : current,
      )
      setPendingDelete(null)
    } catch {
      if (alive.current) setActionError("delete")
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const fill = quota && quota.quotaBytes > 0 ? Math.min(quota.usedBytes, quota.quotaBytes) : 0

  return (
    <section
      aria-label={t("files.title")}
      data-testid="chat-files"
      className="shrink-0 border-b border-subtle bg-app px-4 py-2"
    >
      <div className="mx-auto flex w-full max-w-[768px] flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
            {t("files.title")}
          </h2>
          {quota ? (
            <div className="flex items-center gap-2">
              <progress
                className="progress progress-info h-1 w-20"
                value={fill}
                max={quota.quotaBytes || 1}
                aria-label={t("files.quotaLabel")}
                data-testid="files-quota-bar"
              />
              <span data-testid="files-quota" className="text-xs text-muted">
                {t("files.quota", {
                  used: formatBytes(quota.usedBytes, locale),
                  total: formatBytes(quota.quotaBytes, locale),
                })}
              </span>
            </div>
          ) : null}
        </div>

        {status === "loading" ? (
          <p role="status" aria-live="polite" className="text-xs text-muted">
            {t("files.loading")}
          </p>
        ) : status === "error" ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-muted">
            <span>{t("files.loadFailed")}</span>
            <button type="button" onClick={() => void load()} className="btn btn-ghost btn-xs">
              {t("files.retry")}
            </button>
          </div>
        ) : files.length === 0 ? (
          <p data-testid="files-empty" className="text-xs text-muted">
            {t("files.empty")}
          </p>
        ) : (
          <ul aria-label={t("files.title")} className="max-h-40 overflow-y-auto">
            {files.map((file) => (
              <li key={file.name} className="border-t border-subtle first:border-t-0">
                <div
                  data-testid="chat-file-item"
                  className="flex items-center gap-2 rounded-row px-1 py-1 hover:bg-hover"
                >
                  <span
                    data-testid="chat-file-name"
                    className="min-w-0 flex-1 truncate text-sm"
                    title={file.displayName}
                  >
                    {file.displayName}
                  </span>
                  <span data-testid="chat-file-meta" className="hidden shrink-0 text-xs text-muted sm:inline">
                    {t("files.meta", {
                      size: formatBytes(file.size, locale),
                      origin:
                        file.origin === "upload" ? t("files.originUpload") : t("files.originAgent"),
                      date: formatArtifactDate(file.mtime, locale),
                    })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square"
                    aria-label={t("files.downloadFile", { name: file.displayName })}
                    title={t("files.download")}
                    disabled={busy === file.name}
                    onClick={() => void download(file)}
                  >
                    <DownloadIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square text-error"
                    aria-label={t("files.deleteFile", { name: file.displayName })}
                    title={t("files.delete")}
                    disabled={busy === file.name}
                    onClick={() => {
                      setActionError(null)
                      setPendingDelete(file.name)
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>

                {pendingDelete === file.name ? (
                  <div
                    role="alertdialog"
                    aria-label={t("files.deleteConfirmTitle")}
                    data-testid="chat-file-confirm"
                    className="mb-1 flex flex-wrap items-center gap-2 rounded-row border border-subtle bg-surface px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 text-xs">
                      {t("files.deleteConfirmBody", { name: file.displayName })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => setPendingDelete(null)}
                      disabled={busy === file.name}
                    >
                      {t("files.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-error btn-xs"
                      onClick={() => void remove(file)}
                      disabled={busy === file.name}
                    >
                      {t("files.deleteConfirm")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {actionError ? (
          <p role="alert" data-testid="files-action-error" className="text-xs text-error">
            {actionError === "download" ? t("files.downloadFailed") : t("files.deleteFailed")}
          </p>
        ) : null}
      </div>
    </section>
  )
}
