import type { ErrorPart } from "@openchat/contracts"
import { AlertIcon } from "../components/icons"
import { useT } from "../i18n/provider"

export function ErrorCard({ part }: { part: ErrorPart }) {
  const t = useT()

  return (
    <section
      role="alert"
      data-testid="error-card"
      className="rounded-card border border-error/40 bg-error/10 px-3 py-2 text-error"
    >
      <div className="flex items-center gap-2">
        <AlertIcon className="size-4 shrink-0" />
        <p className="text-sm font-medium">{t("render.error")}</p>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">
        {part.message || t("render.errorUnknown")}
      </p>
      {part.code ? (
        <p className="mt-1 font-mono text-xs opacity-80">
          {t("render.errorCode", { code: part.code })}
        </p>
      ) : null}
      {part.retryable ? <p className="mt-1 text-xs">{t("render.retryable")}</p> : null}
    </section>
  )
}
