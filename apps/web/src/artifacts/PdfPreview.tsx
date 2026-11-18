import type { ArtifactResponse } from "@openchat/contracts"
import { isTrustedArtifactUrl } from "./media"

/**
 * PDF preview. The bytes come from the artifact origin's signed URL; the frame
 * is the same sandboxed viewer as an HTML artifact and never receives markup
 * through `srcDoc`, a `data:` URL or a third-party embed.
 */
export function PdfPreview({
  artifact,
  artifactOrigin,
}: {
  artifact: ArtifactResponse
  artifactOrigin?: string
}) {
  if (!isTrustedArtifactUrl(artifact.url, artifact.id, artifactOrigin)) return null
  return (
    <div data-testid="artifact-pdf-preview" className="flex min-h-0 flex-1 flex-col bg-app">
      <iframe
        data-testid="artifact-pdf-frame"
        src={artifact.url}
        title={artifact.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-full min-h-96 w-full border-0 bg-surface"
      />
    </div>
  )
}
