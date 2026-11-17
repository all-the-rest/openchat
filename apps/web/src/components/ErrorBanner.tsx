import { useT } from "../i18n/provider"
import { AlertIcon } from "./icons"

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string
  onDismiss?: () => void
}) {
  const t = useT()

  return (
    <div
      role="alert"
      className="mb-2 flex w-full items-center gap-3 rounded-card border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
    >
      <AlertIcon className="size-4 shrink-0" />
      <p className="flex-1">{message}</p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="btn btn-ghost btn-xs text-error"
        >
          {t("chat.dismiss")}
        </button>
      ) : null}
    </div>
  )
}
