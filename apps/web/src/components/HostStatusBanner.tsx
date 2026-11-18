import { useEffect, useState } from "react"
import { useEventStreamOrNull } from "../api/events"
import { useSurface } from "../code/SurfaceProvider"
import { useT } from "../i18n/provider"
import { AlertIcon } from "./icons"

/** Id the composer's send control points at while the host is down. */
export const HOST_BANNER_ID = "host-unreachable-banner"

/**
 * Shell-wide state for a dead OpenCode host. The app answering at all proves
 * it is up, so this banner states the split and offers the only useful action:
 * read `/api/info` once more. A dropped event stream is the outage signal; a
 * reopened stream asks again, so the banner clears on reconnect without a
 * reload. It never polls, takes focus, or dismisses itself: the condition, not
 * the notice, decides when it is gone.
 */
export function HostStatusBanner() {
  const t = useT()
  const { hostReachable, refresh } = useSurface()
  const connection = useEventStreamOrNull()?.connection
  const [retrying, setRetrying] = useState(false)

  // The stream is the cheapest proof that the host path changed: it closes
  // when the upstream goes away and reopens when it is back. Ask then, not on a
  // timer; the guards keep one transition to one read.
  useEffect(() => {
    if (connection === "closed" && hostReachable !== false) void refresh()
    if (connection === "open" && hostReachable === false) void refresh()
  }, [connection, hostReachable, refresh])

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
