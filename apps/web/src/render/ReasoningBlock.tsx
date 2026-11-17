import type { ReasoningPart } from "@openchat/contracts"
import { useEffect, useId, useState } from "react"
import { BrainIcon, ChevronDownIcon } from "../components/icons"
import { useT } from "../i18n/provider"

export function ReasoningBlock({
  part,
  streaming,
}: {
  part: ReasoningPart
  streaming: boolean
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(streaming)
  const panelID = useId()

  // Expanded while the model reasons; collapsed once the message settles.
  useEffect(() => {
    setExpanded(streaming)
  }, [streaming])

  return (
    <section className="rounded-card border border-subtle bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={panelID}
        className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-start text-xs text-muted"
      >
        <BrainIcon className="size-4 shrink-0" />
        <span className="font-medium">{t("render.reasoning")}</span>
        {streaming ? (
          <span className="loading loading-dots loading-xs" aria-hidden="true" />
        ) : null}
        {streaming ? <span className="sr-only">{t("render.reasoningStreaming")}</span> : null}
        <ChevronDownIcon
          className={`ms-auto size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <div id={panelID} hidden={!expanded}>
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words border-t border-subtle px-3 py-2 text-sm text-secondary">
          {part.text}
        </div>
      </div>
    </section>
  )
}
