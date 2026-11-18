import { useState } from "react"
import { useSurface } from "../code/SurfaceProvider"
import { useT } from "../i18n/provider"
import { AlertIcon } from "./icons"

/** Id the composer's send control points at while the host is down. */
export const HOST_BANNER_ID = "host-unreachable-banner"

/**
 * Shell-wide state for a dead OpenCode host. The app answering at all proves
 * it is up, so this banner states the split and offers the only useful action:
 * read `/api/info` once more. It never polls, retries on its own, or takes
 * focus, and it is not dismissible because the condition is still true.
 */
export function HostStatusBanner() {
  const t = useT()
  const { hostReachable, refresh } = useSurface()
  const [retrying, setRetrying] = useState(false)

  if (hostReachable !== false) return null

  const retry = async () => {
    setRetrying(true)
    try {
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      id={HOST_BANNER_ID}
      role="status"
      aria-live="polite"
      data-testid="host-unreachable"
      className="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
    >
      <AlertIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("host.unreachable")}</p>
        <p className="text-xs text-warning/90">{t("host.unreachableHint")}</p>
      </div>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className="btn btn-ghost btn-xs shrink-0 text-warning"
      >
        {t("host.retry")}
      </button>
    </div>
  )
}
