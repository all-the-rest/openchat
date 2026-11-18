import { useCallback, useEffect, useRef, useState } from "react"
import type { ArtifactResponse } from "@openchat/contracts"
import { Link, useParams } from "react-router-dom"
import { ApiError, api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { useTheme } from "../theme/provider"
import { useArtifactBridge } from "./bridge"
import type { ArtifactResult } from "./bridge"
import {
  ARTIFACT_REFRESH_MARGIN_MS,
  artifactFilename,
  formatArtifactDate,
  formatBytes,
  needsFreshURL,
  saveBlob,
} from "./files"
import { DraftPanel } from "./DraftPanel"
import { ARTIFACT_LOAD_TIMEOUT_MS, ArtifactFrame, Panel, PresentBar, ViewerChrome } from "./parts"

type Phase = "loading" | "ready" | "missing" | "error"

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

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
 */
export function ArtifactViewer({
  loadTimeoutMs = ARTIFACT_LOAD_TIMEOUT_MS,
  onArtifactResult,
}: {
  loadTimeoutMs?: number
  onArtifactResult?: (result: ArtifactResult) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const { theme } = useTheme()
  const { id = "" } = useParams<{ id: string }>()

  const [phase, setPhase] = useState<Phase>("loading")
  const [meta, setMeta] = useState<ArtifactResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const [frameFailed, setFrameFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [present, setPresent] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [result, setResult] = useState<ArtifactResult | null>(null)

  const alive = useRef(true)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const presentRef = useRef<HTMLButtonElement>(null)
  const exitRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const recovered = useRef(0)
  const recovering = useRef(false)
  const refreshedURLs = useRef(new Set<string>())

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

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A draft belongs to the document that produced it: opening another artifact
  // in the same viewer starts without the previous result.
  useEffect(() => {
    setResult(null)
  }, [id])

  // One metadata read per attempt. A URL that arrives at the edge of its
  // lifetime is replaced by a second read, so the frame never starts on a link
  // that is about to expire.
  useEffect(() => {
    let active = true
    setPhase("loading")
    setMeta(null)
    setFrameFailed(false)
    setLoaded(false)
    setRefreshFailed(false)
    recovered.current = 0
    refreshedURLs.current.clear()
    recovering.current = false

    if (!id) {
      setPhase("missing")
      return () => {
        active = false
      }
    }

    void (async () => {
      try {
        let next = await api.artifact(id)
        if (needsFreshURL(next.expiresAt) && !refreshedURLs.current.has(next.url)) {
          refreshedURLs.current.add(next.url)
          next = await api.artifact(id)
        }
        if (!active) return
        setMeta(next)
        setPhase("ready")
      } catch (error) {
        if (!active) return
        setPhase(isNotFound(error) ? "missing" : "error")
      }
    })()

    return () => {
      active = false
    }
  }, [id, attempt])

  // A frame that reports an error, or never loads at all, is the only signal a
  // cross-origin frame gives (an HTTP 403 is not readable from the parent).
  // One recovery read, then the recoverable panel.
  const recover = useCallback(async () => {
    if (!meta || recovering.current) return
    // Keyed on the attempt, not the URL: a recovery mints a fresh URL, so a
    // URL-keyed guard would re-read forever against a host that keeps failing.
    if (recovered.current >= 1) {
      setFrameFailed(true)
      return
    }
    recovered.current += 1
    recovering.current = true
    try {
      const next = await api.artifact(id)
      if (!alive.current) return
      setMeta(next)
      setFrameFailed(false)
      setLoaded(false)
    } catch {
      if (alive.current) setFrameFailed(true)
    } finally {
      recovering.current = false
    }
  }, [id, meta])

  useEffect(() => {
    if (phase !== "ready" || frameFailed || loaded || !meta) return
    const timer = window.setTimeout(() => void recover(), loadTimeoutMs)
    return () => window.clearTimeout(timer)
  }, [phase, frameFailed, loaded, meta, recover, loadTimeoutMs])

  // Refresh shortly before the signature expires. The frame keeps its last
  // working URL if this read fails; a later reload asks again.
  useEffect(() => {
    if (phase !== "ready" || !meta) return
    const expires = Date.parse(meta.expiresAt)
    if (!Number.isFinite(expires)) return
    const delay = expires - Date.now() - ARTIFACT_REFRESH_MARGIN_MS
    if (delay <= 0) return
    const timer = window.setTimeout(() => {
      void api
        .artifact(id)
        .then((next) => {
          if (!alive.current) return
          setMeta(next)
          setLoaded(false)
          setRefreshFailed(false)
        })
        .catch(() => {
          if (alive.current) setRefreshFailed(true)
        })
    }, Math.min(delay, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [phase, meta, id])

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

  const reload = () => setAttempt((value) => value + 1)

  // Reset restarts the app in place. A ready artifact is asked over the
  // bridge (`artifact:reset`, same nonce, same URL); a document without the
  // shim is remounted with the same URL. Neither mints a new signature.
  const reset = () => {
    if (bridge.reset()) return
    setLoaded(false)
    setFrameFailed(false)
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
      if (alive.current) setDownloadFailed(true)
    } finally {
      if (alive.current) setDownloading(false)
    }
  }

  const metaLine = meta
    ? t("artifacts.meta", {
        size: formatBytes(meta.bytes, locale),
        date: formatArtifactDate(meta.createdAt, locale),
      })
    : null

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
        <button type="button" onClick={reload} className="btn btn-primary btn-sm">
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
          onClick={reload}
          className="btn btn-primary btn-sm"
        >
          {t("artifacts.reload")}
        </button>
        <Link to="/artifacts" className="btn btn-outline btn-sm">
          {t("artifacts.back")}
        </Link>
      </Panel>
    ) : (
      <ArtifactFrame
        key={epoch}
        meta={meta}
        frameRef={frameRef}
        height={bridge.height}
        onLoad={() => {
          setLoaded(true)
          bridge.onLoad()
        }}
        onError={() => void recover()}
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
            canPresent={phase === "ready" && !frameFailed}
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
              onDismiss={() => setRefreshFailed(false)}
            />
          </div>
        ) : null}

        <div
          data-testid="artifact-frame-area"
          className="relative flex min-h-0 flex-1 overflow-y-auto"
        >
          {content}
        </div>

        {!present && result ? (
          <DraftPanel result={result} onDismiss={() => setResult(null)} />
        ) : null}
      </div>
    </div>
  )
}
