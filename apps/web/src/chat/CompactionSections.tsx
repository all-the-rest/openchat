import type { CompactionNotice } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import type { MessageKey } from "../i18n"

const STATUS_KEY: Record<CompactionNotice["status"], MessageKey> = {
  started: "chat.compactionStarted",
  ended: "chat.compactionEnded",
  failed: "chat.compactionFailed",
}

const REASON_KEY: Record<CompactionNotice["reason"], MessageKey> = {
  auto: "chat.compactionAuto",
  manual: "chat.compactionManual",
}

/** One collapsed section per compaction attempt; a failure offers a retry. */
export function CompactionSections({
  notices,
  onRetry,
  disabled = false,
}: {
  notices: CompactionNotice[]
  onRetry?: (id: string) => void
  /** True while a run streams: the host rejects compaction with 409. */
  disabled?: boolean
}) {
  const t = useT()
  if (notices.length === 0) return null

  return (
    <div data-testid="compaction-notices" className="flex flex-col gap-2">
      {notices.map((notice) => (
        <details
          key={notice.id}
          open={notice.status === "failed"}
          data-testid={`compaction-${notice.status}`}
          className="rounded-row border border-subtle bg-surface px-3 py-1.5 text-xs text-secondary"
        >
          <summary className="cursor-pointer select-none">
            {t(STATUS_KEY[notice.status])} · {t(REASON_KEY[notice.reason])}
          </summary>
          {notice.summary ? (
            <div className="pt-2">
              <p className="pb-1 font-medium text-muted">{t("chat.compactionSummaryLabel")}</p>
              <p data-testid="compaction-summary" className="whitespace-pre-wrap break-words">
                {notice.summary}
              </p>
            </div>
          ) : null}
          {notice.error ? (
            <p role="alert" data-testid="compaction-reason" className="pt-2 text-error">
              {notice.error}
            </p>
          ) : null}
          {notice.status === "failed" && onRetry ? (
            <button
              type="button"
              data-testid="compaction-retry"
              disabled={disabled}
              onClick={() => onRetry(notice.id)}
              className="btn btn-ghost btn-xs mt-2"
            >
              {t("chat.compactionRetry")}
            </button>
          ) : null}
        </details>
      ))}
    </div>
  )
}
