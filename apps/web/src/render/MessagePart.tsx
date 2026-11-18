import type { Part } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import { TranscriptArtifact } from "../artifacts/TranscriptArtifact"
import { ErrorCard } from "./ErrorCard"
import { Markdown } from "./Markdown"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolCard } from "./ToolCard"

export function MessagePart({ part, streaming }: { part: Part; streaming: boolean }) {
  const t = useT()

  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />

    case "reasoning":
      return <ReasoningBlock part={part} streaming={streaming} />

    case "tool":
      return <ToolCard part={part} />

    case "error":
      return <ErrorCard part={part} />

    case "artifact":
      return <TranscriptArtifact part={part} />

    default: {
      // Unknown parts never render their payload as HTML.
      const unknown = part as { type?: unknown }
      const type = typeof unknown.type === "string" ? unknown.type : ""
      return (
        <p className="rounded-card border border-subtle bg-surface px-3 py-2 text-xs text-muted">
          {t("render.unknownPart", { type })}
        </p>
      )
    }
  }
}
