import { useT } from "../i18n/provider"
import { AlertIcon, CloseIcon } from "../components/icons"
import { ERROR_MESSAGE_KEYS } from "./errors"
import type { DictationController } from "./useDictation"

/** Busy, limit and error lines below the composer; errors stay actionable. */
export function DictationFeedback({ dictation }: { dictation: DictationController }) {
  const t = useT()
  const transcribing = dictation.status === "transcribing"
  const error = dictation.status === "error" ? dictation.error : null
  const notice = dictation.notice

  if (!transcribing && !error && !notice) return null

  return (
    <div className="mt-2 space-y-1">
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
    </div>
  )
}
