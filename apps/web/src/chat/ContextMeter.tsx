import type { TokenUsage } from "@openchat/contracts"
import { useI18n, useT } from "../i18n/provider"
import { useCompletionOrNull } from "./completion"
import { contextFill } from "./context-fill"

/**
 * The header's context fill. It needs both halves to say anything true: the
 * model's window and the last reported usage. Either missing renders a neutral
 * dash with an explanatory tooltip instead of an invented number.
 */
export function ContextMeter({ usage }: { usage: TokenUsage | null }) {
  const t = useT()
  const { locale } = useI18n()
  const completion = useCompletionOrNull()
  const effectiveModel =
    completion?.model ?? completion?.models.find((entry) => entry.default)?.id ?? null
  const limit =
    completion?.models.find((entry) => entry.id === effectiveModel)?.contextLimit ?? null
  const fill = contextFill(usage, limit)

  if (!fill) {
    return (
      <span
        data-testid="context-fill-unknown"
        title={t("chat.contextUsageUnknown")}
        aria-label={t("chat.contextUsageUnknown")}
        className="shrink-0 text-xs text-muted"
      >
        –
      </span>
    )
  }

  const format = new Intl.NumberFormat(locale)
  const label = t("chat.contextUsage", {
    used: format.format(fill.used),
    limit: format.format(fill.limit),
    percent: fill.percent,
  })

  return (
    <span
      data-testid="context-fill"
      title={t("chat.contextUsageHint")}
      aria-label={label}
      className="shrink-0 text-xs tabular-nums text-muted"
    >
      {label}
    </span>
  )
}
