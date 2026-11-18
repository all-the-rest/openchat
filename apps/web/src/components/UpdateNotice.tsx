import { useEffect, useState } from "react"
import { useT } from "../i18n/provider"
import { useStreamActive } from "../pwa/stream-guard"
import { requestReload, subscribeWaiting } from "../pwa/register"

const STREAM_HINT_ID = "update-streaming-hint"

export interface UpdateNoticeProps {
  /** Injectable so the update flow can be tested without a real worker. */
  subscribe?: (listener: (worker: ServiceWorker | null) => void) => () => void
  reload?: (worker: ServiceWorker) => void
}

/**
 * A new deployment waits for permission. The notice appears only when a worker
 * is actually waiting, and the reload is an explicit button press. While an
 * answer is streaming the button is disabled, so activating the new shell can
 * never cut a response short.
 */
export function UpdateNotice({
  subscribe = subscribeWaiting,
  reload = requestReload,
}: UpdateNoticeProps) {
  const t = useT()
  const streaming = useStreamActive()
  const [worker, setWorker] = useState<ServiceWorker | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => subscribe(setWorker), [subscribe])
  useEffect(() => {
    if (worker) setDismissed(false)
  }, [worker])

  if (!worker || dismissed) return null

  return (
    <div
      role="status"
      data-testid="update-notice"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-accent/40 bg-accent/10 px-4 py-2 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("update.title")}</p>
        <p className="text-xs opacity-90">{t("update.hint")}</p>
        {streaming ? (
          <p id={STREAM_HINT_ID} className="text-xs opacity-90">
            {t("update.streamingHint")}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="update-reload"
        onClick={() => reload(worker)}
        disabled={streaming}
        aria-describedby={streaming ? STREAM_HINT_ID : undefined}
        className="btn btn-primary btn-xs shrink-0"
      >
        {t("update.reload")}
      </button>
      <button
        type="button"
        data-testid="update-dismiss"
        onClick={() => setDismissed(true)}
        className="btn btn-ghost btn-xs shrink-0"
      >
        {t("update.dismiss")}
      </button>
    </div>
  )
}
