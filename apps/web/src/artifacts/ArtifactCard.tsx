import type { ArtifactResponse } from "@openchat/contracts"
import { artifactKind } from "@openchat/contracts/artifacts/mime"
import { useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import type { MessageKey } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { artifactFilename, formatArtifactDate, formatBytes, saveBlob } from "./files"
import { PdfPreview } from "./PdfPreview"
import { isImageArtifact, isPdfArtifact } from "./media"

export interface ArtifactCardProps {
  artifact: ArtifactResponse
  /** Restricts an image `src` to one artifact origin; the BFF URL is the default. */
  artifactOrigin?: string
  /** Gallery/list size: thumbnails only, no nested preview frame. */
  compact?: boolean
  onOpen?(): void
}

type Kind = ReturnType<typeof artifactKind>

const KIND_KEY: Record<Kind, MessageKey> = {
  image: "artifacts.kind.image",
  pdf: "artifacts.kind.pdf",
  file: "artifacts.kind.file",
  html: "artifacts.kind.html",
}

/** A download never navigates to the signed URL and leaves no signed link behind. */
function useDownload(artifact: ArtifactResponse) {
  const [downloading, setDownloading] = useState(false)
  const [failed, setFailed] = useState(false)
  const download = async () => {
    if (downloading) return
    setDownloading(true)
    setFailed(false)
    try {
      const blob = await api.artifactDownload(artifact.id)
      saveBlob(blob, artifactFilename(artifact.title, artifact.mime))
    } catch {
      setFailed(true)
    } finally {
      setDownloading(false)
    }
  }
  return { download, downloading, failed, dismiss: () => setFailed(false) }
}

/**
 * The one renderer for an artifact produced during a turn. Images use the
 * signed URL from the BFF — never a remote image host — with capped dimensions
 * and lazy loading. PDFs use the sandboxed preview; everything else is a plain
 * file card with the same download action.
 */
export function ArtifactCard({ artifact, artifactOrigin, compact = false, onOpen }: ArtifactCardProps) {
  const t = useT()
  const { locale } = useI18n()
  const { download, downloading, failed, dismiss } = useDownload(artifact)
  const image = isImageArtifact(artifact, artifactOrigin)
  const pdf = isPdfArtifact(artifact)
  const kind = artifactKind(artifact.mime)

  const open = onOpen ? (
    <button type="button" onClick={onOpen} className="btn btn-sm">
      {t("artifacts.open", { title: artifact.title })}
    </button>
  ) : (
    <Link to={`/artifacts/${artifact.id}`} className="btn btn-sm">
      {t("artifacts.open", { title: artifact.title })}
    </Link>
  )

  const actions = (
    <div className="card-actions flex-wrap items-center gap-2">
      {open}
      <button
        type="button"
        data-testid="artifact-card-download"
        onClick={() => void download()}
        disabled={downloading}
        className="btn btn-outline btn-sm"
      >
        {downloading ? t("artifacts.downloading") : t("artifacts.download")}
      </button>
    </div>
  )

  return (
    <section
      data-testid={image ? "artifact-image-card" : pdf ? "artifact-pdf-card" : "artifact-file-card"}
      className={`card card-sm overflow-hidden rounded-card border border-subtle bg-surface ${compact ? "w-full" : "max-w-image-card"}`}
    >
      {image ? (
        <figure className="flex justify-center bg-app">
          <img
            data-testid="artifact-image"
            src={artifact.url}
            alt={artifact.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={`max-h-image-preview w-full object-contain ${compact ? "h-24" : ""}`}
          />
        </figure>
      ) : null}
      {pdf && !compact ? <PdfPreview artifact={artifact} artifactOrigin={artifactOrigin} /> : null}
      <div className="card-body gap-2 p-3">
        <div className="flex items-start gap-2">
          <h3 className="card-title min-w-0 flex-1 truncate text-sm">{artifact.title}</h3>
          <span className="badge badge-outline badge-sm" data-testid="artifact-card-kind">
            {t(KIND_KEY[kind])}
          </span>
        </div>
        <p className="text-xs text-muted">
          {t("artifacts.meta", {
            size: formatBytes(artifact.bytes, locale),
            date: formatArtifactDate(artifact.createdAt, locale),
          })}
        </p>
        {failed ? <ErrorBanner message={t("artifacts.downloadFailed")} onDismiss={dismiss} /> : null}
        {actions}
      </div>
    </section>
  )
}
