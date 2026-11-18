import { useT } from "../i18n/provider"
import { useOffline } from "../pwa/offline"
import { AlertIcon } from "./icons"

/** Id the offline composer points at for its explanation. */
export const OFFLINE_BANNER_ID = "offline-banner"

/**
 * Shell-wide offline state. Unlike the host banner, this is about the browser's
 * own connection: it appears when `navigator.onLine` is false or an API fetch
 * failed, and clears on the matching recovery signal. It takes no action and
 * never dismisses itself — the connection decides.
 */
export function OfflineBanner() {
  const t = useT()
  const offline = useOffline()
  if (!offline) return null

  return (
    <div
      id={OFFLINE_BANNER_ID}
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex shrink-0 items-center gap-3 border-b border-error/40 bg-error/10 px-4 py-2 text-sm text-error"
    >
      <AlertIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("offline.title")}</p>
        <p className="text-xs text-error/90">{t("offline.hint")}</p>
      </div>
    </div>
  )
}
