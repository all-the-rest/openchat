import { STT_MODEL_TOTAL_BYTES } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import { AlertIcon, CloseIcon } from "../components/icons"
import { ERROR_MESSAGE_KEYS } from "./errors"
import { formatBytes } from "./format"
import type { DictationController } from "./useDictation"

/** Busy, download, limit and error lines plus the always-visible path label. */
export function DictationFeedback({ dictation }: { dictation: DictationController }) {
  const t = useT()
  const transcribing = dictation.status === "transcribing"
  const error = dictation.status === "error" ? dictation.error : null
  const notice = dictation.notice
  const progress = dictation.progress
  const size = formatBytes(STT_MODEL_TOTAL_BYTES)

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2 px-2">
        <p data-testid="dictation-path" className="text-xs text-muted">
          {t(dictation.path === "local" ? "dictation.path.local" : "dictation.path.server")}
        </p>
        {dictation.path === "local" ? (
          <button
            type="button"
            data-testid="dictation-delete-model"
            onClick={() => void dictation.forgetModel()}
            className="btn btn-ghost btn-xs min-h-9 text-muted"
          >
            {t("dictation.model.delete")}
          </button>
        ) : null}
      </div>

      {progress ? (
        <div data-testid="dictation-progress" className="px-2 text-xs text-muted">
          <p>
            {t("dictation.model.progress", {
              file: progress.file,
              loaded: formatBytes(progress.loaded),
              total: formatBytes(progress.total || STT_MODEL_TOTAL_BYTES),
            })}
          </p>
          <progress
            className="progress progress-primary w-full"
            value={progress.loaded}
            max={progress.total || STT_MODEL_TOTAL_BYTES}
          />
        </div>
      ) : null}

      {transcribing ? (
        <p role="status" data-testid="dictation-busy" className="px-2 text-xs text-muted">
          {t("dictation.transcribing")}
        </p>
      ) : null}
      {notice ? (
        <p role="status" data-testid="dictation-notice" className="px-2 text-xs text-warning">
          {notice.kind === "time"
            ? t("dictation.limit.time", { duration: notice.value })
            : t("dictation.limit.size", { size: notice.value })}
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          data-testid="dictation-error"
          className="flex flex-wrap items-center gap-2 rounded-card border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
        >
          <AlertIcon className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">{t(ERROR_MESSAGE_KEYS[error])}</p>
          <button
            type="button"
            data-testid="dictation-retry"
            onClick={dictation.retry}
            className="btn btn-ghost btn-xs min-h-9 text-error"
          >
            {t("dictation.retry")}
          </button>
          <button
            type="button"
            onClick={dictation.dismiss}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="btn btn-ghost btn-xs min-h-9 min-w-9 text-error"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
      ) : null}

      {dictation.consentPending ? (
        <dialog open data-testid="dictation-consent" aria-label={t("dictation.download.title")} className="modal modal-open">
          <div className="modal-box">
            <h3 className="text-lg font-bold">{t("dictation.download.title")}</h3>
            <p className="py-4">{t("dictation.download.body", { size })}</p>
            <div className="modal-action flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="dictation-consent-download"
                onClick={dictation.chooseLocal}
                className="btn btn-primary"
              >
                {t("dictation.download.start")}
              </button>
              {dictation.serverAvailable ? (
                <button
                  type="button"
                  data-testid="dictation-consent-server"
                  onClick={dictation.chooseServer}
                  className="btn"
                >
                  {t("dictation.download.server")}
                </button>
              ) : null}
              <button
                type="button"
                data-testid="dictation-consent-cancel"
                onClick={dictation.decline}
                className="btn"
              >
                {t("dictation.download.cancel")}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  )
}
