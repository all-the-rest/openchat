import { useT } from "../i18n/provider"
import { CloseIcon, StopIcon } from "../components/icons"
import { formatDuration } from "./format"

export interface RecordingPillProps {
  elapsedMs: number
  level: number
  requesting: boolean
  onStop(): void
  onCancel(): void
}

/** Live recording status: elapsed clock, RMS meter, stop and cancel. */
export function RecordingPill({ elapsedMs, level, requesting, onStop, onCancel }: RecordingPillProps) {
  const t = useT()
  const elapsed = formatDuration(elapsedMs)
  const percent = Math.round(Math.max(0, Math.min(1, level)) * 100)

  return (
    <div
      data-testid="dictation-pill"
      className="mb-2 flex w-full items-center gap-3 rounded-full border border-strong bg-surface px-3 py-1.5"
    >
      <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-error" aria-hidden="true" />
      {requesting ? (
        <span className="flex-1 truncate text-sm text-muted">{t("dictation.requesting")}</span>
      ) : (
        <>
          <span className="sr-only">{t("dictation.recording")}</span>
          <span
            data-testid="dictation-elapsed"
            aria-label={t("dictation.elapsed", { duration: elapsed })}
            className="font-mono text-sm tabular-nums"
          >
            {elapsed}
          </span>
          <div
            data-testid="dictation-level"
            role="meter"
            aria-label={t("dictation.level")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-24 max-w-[40vw] overflow-hidden rounded-full bg-hover"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-100"
              style={{ width: `${percent}%` }}
            />
          </div>
        </>
      )}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {requesting ? null : (
          <button
            type="button"
            data-testid="dictation-stop"
            onClick={onStop}
            aria-label={t("dictation.stop")}
            title={t("dictation.stop")}
            className="btn btn-ghost btn-xs min-h-9 min-w-9"
          >
            <StopIcon className="size-4" />
          </button>
        )}
        <button
          type="button"
          data-testid="dictation-cancel"
          onClick={onCancel}
          aria-label={t("dictation.cancel")}
          title={t("dictation.cancel")}
          className="btn btn-ghost btn-xs min-h-9 min-w-9"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
    </div>
  )
}
