import type { ReactNode, RefObject } from "react"
import type { ArtifactResponse } from "@openchat/contracts"

/** A frame that never fires `load` is treated as a refused URL. */
export const ARTIFACT_LOAD_TIMEOUT_MS = 10_000

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
  onLoad,
  onError,
}: {
  meta: ArtifactResponse
  frameRef: RefObject<HTMLIFrameElement | null>
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
      className="h-full w-full border-0 bg-surface"
    />
  )
}
