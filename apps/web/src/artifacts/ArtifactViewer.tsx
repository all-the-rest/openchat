import { artifactKind } from "@openchat/contracts/artifacts/mime"
import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { useTheme } from "../theme/provider"
import { useArtifactBridge } from "./bridge"
import type { ArtifactResult } from "./bridge"
import { ARTIFACT_HANDSHAKE_GRACE_MS, useArtifactDocument } from "./document"
import { artifactFilename, formatArtifactDate, formatBytes, saveBlob } from "./files"
import { ArtifactCard } from "./ArtifactCard"
import { DraftPanel } from "./DraftPanel"
import { PdfPreview } from "./PdfPreview"
import { ARTIFACT_LOAD_TIMEOUT_MS, ArtifactFrame, Panel, PresentBar, ViewerChrome } from "./parts"

/**
 * `/artifacts/:id` — one document in the sandboxed frame. The URL always comes
 * from `GET /api/artifacts/:id`; it is never assembled here. Every read mints a
 * fresh URL, so reload and the pre-expiry refresh both re-read the metadata.
 *
 * Reset is the exception: it restarts the app in the current frame with the
 * same signed URL, so it neither mints nor loses the viewer's present mode.
 *
 * A result from the artifact's bridge becomes an editable draft in the panel
 * below the frame, and is handed to `onArtifactResult` when the caller passed
 * one (an inline chat card's insert seam). One result handler feeds both; there
 * is no second path that could disagree about what the artifact returned.
 *
 * A signed URL that expires while the document is open makes the frame load the
 * artifact host's JSON 403. `useArtifactDocument` treats a load without
 * `artifact:ready` as "not the document", covers the frame while it decides,
 * and replaces the URL once. A generation-1 document has no shim, so a second
 * silent frame is accepted instead of declared an error.
 */
export function ArtifactViewer({
  loadTimeoutMs = ARTIFACT_LOAD_TIMEOUT_MS,
  handshakeGraceMs = ARTIFACT_HANDSHAKE_GRACE_MS,
  onArtifactResult,
}: {
  loadTimeoutMs?: number
  handshakeGraceMs?: number
  onArtifactResult?: (result: ArtifactResult) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const { theme } = useTheme()
  const { id = "" } = useParams<{ id: string }>()

  const [epoch, setEpoch] = useState(0)
  const [present, setPresent] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [result, setResult] = useState<ArtifactResult | null>(null)

  const frameRef = useRef<HTMLIFrameElement>(null)
  const presentRef = useRef<HTMLButtonElement>(null)
  const exitRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)

  // The single result path: the draft panel always sees the accepted result,
  // and the optional callback sees the same value. A new result is a new prop;
  // the panel decides whether it may replace what the user typed.
  const onResult = useCallback(
    (next: ArtifactResult) => {
      setResult(next)
      onArtifactResult?.(next)
    },
    [onArtifactResult],
  )

  const bridge = useArtifactBridge({
    frameRef,
    artifactId: id,
    theme,
    locale,
    epoch,
    onResult,
  })

  const doc = useArtifactDocument({
    id,
    handshake: bridge.status,
    loadTimeoutMs,
    handshakeGraceMs,
  })
  const { phase, meta, frameFailed, legacy, refreshFailed } = doc

  // A draft belongs to the document that produced it: opening another artifact
  // in the same viewer starts without the previous result.
  useEffect(() => {
    setResult(null)
  }, [id])

  // Escape leaves present mode and returns focus to the trigger. A key pressed
  // inside the cross-origin frame never reaches this window.
  useEffect(() => {
    if (!present) {
      if (restoreFocus.current) {
        restoreFocus.current = false
        presentRef.current?.focus()
      }
      return
    }
    exitRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      restoreFocus.current = true
      setPresent(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [present])

  // Reset restarts the app in place. A ready artifact is asked over the
  // bridge (`artifact:reset`, same nonce, same URL); a document without the
  // shim is remounted with the same URL. Neither mints a new signature.
  const reset = () => {
    if (bridge.reset()) return
    doc.onFrameReset()
    setEpoch((value) => value + 1)
  }

  const download = async () => {
    if (!meta || downloading) return
    setDownloading(true)
    setDownloadFailed(false)
    try {
      const blob = await api.artifactDownload(meta.id)
      saveBlob(blob, artifactFilename(meta.title))
    } catch {
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }

  const metaLine = meta
    ? t("artifacts.meta", {
        size: formatBytes(meta.bytes, locale),
        date: formatArtifactDate(meta.createdAt, locale),
      })
    : null

  const verified = bridge.status === "ready" || legacy
  const verifying = phase === "ready" && !frameFailed && !verified

  const content =
    phase === "loading" ? (
      <div
        role="status"
        aria-live="polite"
        data-testid="artifact-viewer-loading"
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted"
      >
        <span className="loading loading-spinner loading-sm" aria-hidden="true" />
        {t("artifacts.viewerLoading")}
      </div>
    ) : phase === "missing" ? (
      <Panel title={t("artifacts.missingTitle")} body={t("artifacts.missingBody")} alert>
        <Link to="/artifacts" className="btn btn-sm">
          {t("artifacts.back")}
        </Link>
      </Panel>
    ) : phase === "error" ? (
      <Panel title={t("artifacts.errorTitle")} body={t("artifacts.errorBody")} alert>
        <button type="button" onClick={doc.reload} className="btn btn-primary btn-sm">
          {t("artifacts.retry")}
        </button>
        <Link to="/artifacts" className="btn btn-outline btn-sm">
          {t("artifacts.back")}
        </Link>
      </Panel>
    ) : frameFailed || !meta ? (
      <Panel title={t("artifacts.staleTitle")} body={t("artifacts.staleBody")} alert>
        <button
          type="button"
          data-testid="artifact-stale-retry"
          onClick={doc.reload}
          className="btn btn-primary btn-sm"
        >
          {t("artifacts.reload")}
        </button>
        <Link to="/artifacts" className="btn btn-outline btn-sm">
          {t("artifacts.back")}
        </Link>
      </Panel>
    ) : artifactKind(meta.mime) === "image" ? (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
        <ArtifactCard artifact={meta} />
      </div>
    ) : artifactKind(meta.mime) === "pdf" ? (
      <PdfPreview artifact={meta} />
    ) : (
      <ArtifactFrame
        key={epoch}
        meta={meta}
        frameRef={frameRef}
        height={bridge.height}
        onLoad={() => {
          doc.onLoad()
          bridge.onLoad()
        }}
        onError={doc.onFrameError}
      />
    )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-app">
      <div
        data-testid={present ? "artifact-present-layer" : undefined}
        className={
          present
            ? "absolute inset-0 z-20 flex min-h-0 flex-col bg-app"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {present ? (
          <PresentBar
            title={meta?.title}
            exitRef={exitRef}
            onExit={() => {
              restoreFocus.current = true
              setPresent(false)
            }}
          />
        ) : (
          <ViewerChrome
            title={meta?.title ?? null}
            metaLine={metaLine}
            hasMeta={meta !== null}
            loading={phase === "loading"}
            downloading={downloading}
            canPresent={phase === "ready" && !frameFailed && verified}
            presentRef={presentRef}
            onDownload={() => void download()}
            onReset={reset}
            onPresent={() => {
              restoreFocus.current = false
              setPresent(true)
            }}
          />
        )}

        {downloadFailed && !present ? (
          <div className="border-b border-subtle px-3 py-2">
            <ErrorBanner
              message={t("artifacts.downloadFailed")}
              onDismiss={() => setDownloadFailed(false)}
            />
          </div>
        ) : null}

        {refreshFailed && !present ? (
          <div className="border-b border-subtle px-3 py-2">
            <ErrorBanner
              message={t("artifacts.refreshFailed")}
              onDismiss={doc.dismissRefreshFailure}
            />
          </div>
        ) : null}

        <div
          data-testid="artifact-frame-area"
          className="relative flex min-h-0 flex-1 overflow-y-auto"
        >
          {content}
          {verifying ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="artifact-handshake-cover"
              className="absolute inset-0 flex items-center justify-center gap-2 bg-app text-sm text-muted"
            >
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
              {t("artifacts.viewerLoading")}
            </div>
          ) : null}
        </div>

        {!present && result ? (
          <DraftPanel result={result} onDismiss={() => setResult(null)} />
        ) : null}
      </div>
    </div>
  )
}
