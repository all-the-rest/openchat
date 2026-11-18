import { useCallback, useEffect, useId, useRef, useState } from "react"
import { contextTokens } from "@openchat/contracts"
import type { TokenUsage } from "@openchat/contracts"
import { useCompletionOrNull } from "./completion"
import { useI18n, useT } from "../i18n/provider"
import { toUsageReport, usageView } from "./usage"

function formatCount(value: number, locale: "en" | "de"): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/**
 * Reported token usage of the current chat (issue #8). Values come from the
 * host through the session snapshot or `session.usage.updated`; when neither
 * exists the panel says so instead of showing zeros. The context limit is the
 * selected model's published window, or "not reported" when it has none.
 */
export function UsagePanel({ report }: { report: TokenUsage | null }) {
  const t = useT()
  const { locale } = useI18n()
  const completion = useCompletionOrNull()
  const model = completion?.model ?? null
  const models = completion?.models ?? []
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelID = useId()

  // A default model only resolves to a limit when the catalogue has exactly
  // one entry; otherwise the choice is the owner's and may differ from the
  // host default, so no window is claimed.
  const selected = model ?? (models.length === 1 ? (models[0]?.id ?? null) : null)
  const contextLimit = models.find((entry) => entry.id === selected)?.contextLimit ?? null
  const view = usageView(toUsageReport(report), contextLimit)
  // The meter and the panel must agree: both count prompt tokens with the
  // provider cache, never input+output alone.
  const used = report ? contextTokens(report) : 0
  const fill =
    contextLimit !== null && contextLimit > 0 && used > 0
      ? { ratio: Math.min(1, used / contextLimit) }
      : null

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close(true)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, close])

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        data-testid="usage-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("usage.trigger")}
        title={t("usage.trigger")}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="btn btn-ghost btn-sm"
      >
        {t("usage.trigger")}
      </button>

      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="dialog"
          aria-label={t("usage.label")}
          data-testid="usage-panel"
          className="absolute end-0 top-full z-50 mt-1 w-64 rounded-row border border-subtle bg-elevated p-3 shadow-lg"
        >
          {view.reported ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt className="text-secondary">{t("usage.input")}</dt>
              <dd className="text-end tabular-nums" data-testid="usage-input">
                {formatCount(view.input ?? 0, locale)}
              </dd>
              <dt className="text-secondary">{t("usage.output")}</dt>
              <dd className="text-end tabular-nums" data-testid="usage-output">
                {formatCount(view.output ?? 0, locale)}
              </dd>
              {view.cached !== null ? (
                <>
                  <dt className="text-secondary">{t("usage.cached")}</dt>
                  <dd className="text-end tabular-nums" data-testid="usage-cached">
                    {formatCount(view.cached, locale)}
                  </dd>
                </>
              ) : null}
              <dt className="text-secondary">{t("usage.contextLimit")}</dt>
              <dd className="text-end tabular-nums" data-testid="usage-limit">
                {view.contextLimit !== null ? (
                  formatCount(view.contextLimit, locale)
                ) : (
                  <span className="text-muted">{t("usage.notReportedShort")}</span>
                )}
              </dd>
            </dl>
          ) : (
            <p data-testid="usage-not-reported" className="text-sm text-muted">
              {t("usage.notReported")}
            </p>
          )}

          {fill ? (
            <div
              role="progressbar"
              aria-label={t("usage.fill")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fill.ratio * 100)}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-hover"
            >
              <div className="h-full bg-primary" style={{ width: `${fill.ratio * 100}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
