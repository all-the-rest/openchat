import type { ReactNode, RefObject } from "react"
import type { ArtifactResponse } from "@openchat/contracts"
import { Link } from "react-router-dom"
import { useT } from "../i18n/provider"

/** A frame that never fires `load` is treated as a refused URL. */
export const ARTIFACT_LOAD_TIMEOUT_MS = 10_000

/**
 * The chrome's minimal counterpart in present mode: the title and the way out,
 * nothing that competes with the document for space.
 */
export function PresentBar({
  title,
  exitRef,
  onExit,
}: {
  title?: string
  exitRef: RefObject<HTMLButtonElement | null>
  onExit(): void
}) {
  const t = useT()
  return (
    <div
      role="region"
      aria-label={t("artifacts.presentRegion")}
      data-testid="artifact-present-bar"
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-subtle px-3 py-1"
    >
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
      <button
        ref={exitRef}
        type="button"
        data-testid="artifact-exit-present"
        onClick={onExit}
        className="btn btn-outline btn-sm"
      >
        {t("artifacts.exitPresent")}
      </button>
    </div>
  )
}

/** The viewer's header: back, title with metadata, download, reset, present. */
export function ViewerChrome({
  title,
  metaLine,
  hasMeta,
  loading,
  downloading,
  canPresent,
  presentRef,
  onDownload,
  onReset,
  onPresent,
}: {
  /** Artifact title, or `null` before the metadata arrives. */
  title: string | null
  metaLine: string | null
  hasMeta: boolean
  loading: boolean
  downloading: boolean
  canPresent: boolean
  presentRef: RefObject<HTMLButtonElement | null>
  onDownload(): void
  onReset(): void
  onPresent(): void
}) {
  const t = useT()
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-3 py-2">
      <Link to="/artifacts" data-testid="artifact-back" className="btn btn-ghost btn-sm">
        {t("artifacts.back")}
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">{title ?? t("artifacts.viewerTitle")}</h1>
        {metaLine ? (
          <p data-testid="artifact-viewer-meta" className="text-xs text-muted">
            {metaLine}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="artifact-download"
        onClick={onDownload}
        disabled={!hasMeta || downloading}
        className="btn btn-outline btn-sm"
      >
        {downloading ? t("artifacts.downloading") : t("artifacts.download")}
      </button>
      <button
        type="button"
        data-testid="artifact-reset"
        onClick={onReset}
        disabled={loading}
        className="btn btn-outline btn-sm"
      >
        {t("artifacts.reset")}
      </button>
      <button
        ref={presentRef}
        type="button"
        data-testid="artifact-present"
        onClick={onPresent}
        disabled={!canPresent}
        className="btn btn-outline btn-sm"
      >
        {t("artifacts.present")}
      </button>
    </header>
  )
}

export function Panel({
  title,
  body,
  alert = false,
  children,
}: {
  title: string
  body: string
  alert?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10">
      <div
        role={alert ? "alert" : undefined}
        className="w-full max-w-md rounded-card border border-subtle bg-surface p-5 text-center"
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted">{body}</p>
        {children ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The one frame both modes use. `sandbox="allow-scripts"` is the documented
 * attribute: `allow-same-origin` must never join it, because that would give the
 * artifact the host origin's storage and cookies.
 */
export function ArtifactFrame({
  meta,
  frameRef,
  height = null,
  onLoad,
  onError,
}: {
  meta: ArtifactResponse
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Last `artifact:resize` height; `null` keeps the frame filled. */
  height?: number | null
  onLoad(): void
  onError(): void
}) {
  return (
    <iframe
      ref={frameRef}
      src={meta.url}
      title={meta.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      data-testid="artifact-frame"
      onLoad={onLoad}
      onError={onError}
      style={height === null ? undefined : { height }}
      className={
        height === null ? "h-full w-full border-0 bg-surface" : "w-full border-0 bg-surface"
      }
    />
  )
}
