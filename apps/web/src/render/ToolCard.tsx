import type { ToolPart, ToolStatus } from "@openchat/contracts"
import { useId, useState } from "react"
import { AlertIcon, ChevronDownIcon, ToolIcon } from "../components/icons"
import type { MessageKey } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { formatDuration } from "../lib/format"

const TRUNCATE_AT = 2000

const STATUS_KEYS: Record<ToolStatus, MessageKey> = {
  queued: "tool.status.queued",
  running: "tool.status.running",
  success: "tool.status.success",
  error: "tool.status.error",
}

const STATUS_DOT: Record<ToolStatus, string> = {
  queued: "bg-muted",
  running: "bg-primary motion-safe:animate-pulse",
  success: "bg-success",
  error: "bg-error",
}

function DetailSection({
  label,
  text,
  tone = "default",
}: {
  label: string
  text: string
  tone?: "default" | "error"
}) {
  const t = useT()
  const panelID = useId()
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState(false)
  const truncated = text.length > TRUNCATE_AT
  const shown = full || !truncated ? text : text.slice(0, TRUNCATE_AT)

  return (
    <div className="border-t border-subtle">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={panelID}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium text-secondary"
      >
        <span>{label}</span>
        <ChevronDownIcon
          className={`ms-auto size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <div id={panelID} hidden={!expanded} className="px-3 pb-2">
        <pre
          className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-row bg-code-bg p-2 font-mono text-xs ${
            tone === "error" ? "text-error" : "text-base-content"
          }`}
        >
          {shown}
          {truncated && !full ? "…" : ""}
        </pre>
        {truncated ? (
          <button
            type="button"
            onClick={() => setFull((current) => !current)}
            className="btn btn-ghost btn-xs mt-1 px-0 text-primary"
          >
            {full ? t("render.showLess") : t("render.showFull")}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function ToolCard({ part }: { part: ToolPart }) {
  const t = useT()
  const { locale } = useI18n()

  const duration =
    part.startedAt !== undefined && part.endedAt !== undefined
      ? formatDuration(part.startedAt, part.endedAt, locale)
      : null

  return (
    <section
      data-testid="tool-card"
      className="overflow-hidden rounded-card border border-subtle bg-surface"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <ToolIcon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-base-content">
          {part.name}
        </span>
        {duration ? <span className="text-xs text-muted">{duration}</span> : null}
        <span className="flex items-center gap-1.5 text-xs text-secondary">
          <span className={`size-2 rounded-full ${STATUS_DOT[part.status]}`} aria-hidden="true" />
          {t(STATUS_KEYS[part.status])}
        </span>
      </header>

      {part.input !== undefined ? (
        <DetailSection label={t("render.toolInput")} text={part.input} />
      ) : null}

      {part.output !== undefined ? (
        <DetailSection label={t("render.toolOutput")} text={part.output} />
      ) : null}

      {part.error ? (
        <div className="flex items-start gap-2 border-t border-subtle px-3 py-2 text-sm text-error">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium">{t("render.error")}</p>
            <p className="whitespace-pre-wrap break-words">{part.error}</p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
