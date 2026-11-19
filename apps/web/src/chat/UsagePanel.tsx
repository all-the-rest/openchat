import { useId, useState } from "react"
import { useI18n, useT } from "../i18n/provider"
import { useCompletionOrNull } from "./completion"
import { contextFill, contextLimitFor, hasUsage, type UsageSnapshot } from "./usage"

const ROW = "flex items-center justify-between gap-4 border-b border-subtle py-1.5 text-xs last:border-0"

/**
 * Host-reported token counters for the current chat. Every value comes from a
 * `session.usage.updated` event or the model catalogue; missing values read
 * "not reported" and the context fill is omitted rather than guessed.
 */
export function UsagePanel({ usage }: { usage: UsageSnapshot | null }) {
  const t = useT()
  const { locale } = useI18n()
  const completion = useCompletionOrNull()
  const [open, setOpen] = useState(false)
  const panelID = useId()

  const models = completion?.models ?? []
  const limit = contextLimitFor(models, completion?.model ?? null)
  const fill = contextFill(usage, limit)
  const reported = hasUsage(usage)
  const number = new Intl.NumberFormat(locale)
  const value = (counter: number | undefined) =>
    counter === undefined ? t("usage.notReported") : number.format(counter)

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="usage-toggle"
        aria-expanded={open}
        aria-controls={panelID}
        onClick={() => setOpen((current) => !current)}
        className="btn btn-ghost btn-sm text-xs"
      >
        {t("usage.label")}
      </button>

      {open ? (
        <section
          id={panelID}
          role="region"
          aria-label={t("usage.title")}
          data-testid="usage-panel"
          className="absolute end-0 top-full z-50 mt-1 w-64 rounded-row border border-subtle bg-elevated p-3 shadow-lg"
        >
          <h2 className="pb-1 text-xs font-semibold text-secondary">{t("usage.title")}</h2>
          <dl data-testid="usage-values">
            <div className={ROW}>
              <dt>{t("usage.input")}</dt>
              <dd data-testid="usage-input">{value(usage?.input)}</dd>
            </div>
            <div className={ROW}>
              <dt>{t("usage.output")}</dt>
              <dd data-testid="usage-output">{value(usage?.output)}</dd>
            </div>
            <div className={ROW}>
              <dt>{t("usage.cached")}</dt>
              <dd data-testid="usage-cached">{value(usage?.cached)}</dd>
            </div>
            <div className={ROW}>
              <dt>{t("usage.context")}</dt>
              <dd data-testid="usage-context">
                {limit === null ? t("usage.notReported") : number.format(limit)}
              </dd>
            </div>
            {fill !== null ? (
              <div className={ROW}>
                <dt>{t("usage.label")}</dt>
                <dd data-testid="usage-fill">
                  {t("usage.contextFill", {
                    percent: new Intl.NumberFormat(locale, {
                      style: "percent",
                      maximumFractionDigits: 0,
                    }).format(fill),
                  })}
                </dd>
              </div>
            ) : null}
          </dl>
          {!reported ? (
            <p data-testid="usage-unknown" className="pt-2 text-xs text-muted">
              {t("usage.notReported")}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
