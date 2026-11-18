import type { ArtifactPart } from "@openchat/contracts"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { useT } from "../i18n/provider"
import { ArtifactCard } from "./ArtifactCard"

/**
 * Transcript renderer for an `artifact` part. The part carries an id, not a
 * signed URL: each mount reads the metadata so a long-lived message never
 * holds a URL that expired. The bytes still come from the artifact origin.
 */
export function TranscriptArtifact({ part }: { part: ArtifactPart }) {
  const t = useT()
  const [artifact, setArtifact] = useState<Awaited<ReturnType<typeof api.artifact>> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setArtifact(null)
    setFailed(false)
    void api
      .artifact(part.artifactID)
      .then((next) => {
        if (active) setArtifact(next)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [part.artifactID])

  if (artifact) return <ArtifactCard artifact={artifact} />
  return (
    <section data-testid="artifact-transcript-card" className="rounded-card border border-subtle bg-surface p-3">
      <h3 className="truncate text-sm font-semibold">{part.title}</h3>
      <p role={failed ? "alert" : "status"} className="mt-1 text-xs text-muted">
        {failed ? t("artifacts.missingBody") : t("artifacts.viewerLoading")}
      </p>
    </section>
  )
}
