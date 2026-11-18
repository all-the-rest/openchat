import type { ArtifactResponse } from "@openchat/contracts"
import { Link } from "react-router-dom"
import { useT } from "../i18n/provider"
import { isImageArtifact } from "./media"

/**
 * Compact image-only view of the artifacts page. Each thumbnail is an ordinary
 * link, so tab/Enter work without a second keyboard handler, and opening one
 * uses the existing `/artifacts/:id` viewer (which mints a fresh URL).
 */
export function ImageGallery({
  artifacts,
  artifactOrigin,
}: {
  artifacts: ArtifactResponse[]
  artifactOrigin?: string
}) {
  const t = useT()
  const images = artifacts.filter((artifact) => isImageArtifact(artifact, artifactOrigin))
  if (images.length === 0) return null

  return (
    <section data-testid="artifact-gallery" aria-label={t("artifacts.galleryTitle")}>
      <h2 className="mb-2 text-sm font-semibold">{t("artifacts.galleryTitle")}</h2>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((artifact) => (
          <li key={artifact.id}>
            <Link
              to={`/artifacts/${artifact.id}`}
              data-testid="artifact-gallery-item"
              aria-label={t("artifacts.open", { title: artifact.title })}
              className="flex flex-col overflow-hidden rounded-card border border-subtle bg-surface hover:bg-hover focus-visible:bg-hover"
            >
              <img
                data-testid="artifact-gallery-image"
                src={artifact.url}
                alt={artifact.title}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-24 w-full object-cover"
              />
              <span className="truncate px-2 py-1 text-xs text-base-content">{artifact.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
