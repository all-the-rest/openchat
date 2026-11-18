import { useCallback, useEffect, useRef, useState } from "react"
import type { ArtifactResponse } from "@openchat/contracts"
import { Link } from "react-router-dom"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { formatArtifactDate, formatBytes } from "./files"
import { ImageGallery } from "./ImageGallery"

type LoadStatus = "loading" | "ready" | "error"

/**
 * `/artifacts` — the read-only list of documents the agent has written. The
 * rows are metadata only; opening one is a separate read that mints a fresh
 * signed URL for the viewer.
 */
export function ArtifactsPage() {
  const t = useT()
  const { locale } = useI18n()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [items, setItems] = useState<ArtifactResponse[]>([])
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setStatus("loading")
    try {
      const response = await api.artifacts()
      if (!alive.current) return
      setItems(response)
      setStatus("ready")
    } catch {
      if (!alive.current) return
      setStatus("error")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t("artifacts.title")}</h1>
          <p className="text-sm text-muted">{t("artifacts.description")}</p>
        </header>

        {status === "ready" ? <ImageGallery artifacts={items} /> : null}

        {status === "loading" ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="artifacts-loading"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            {t("artifacts.loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner message={t("artifacts.loadFailed")} />
            <button type="button" onClick={() => void load()} className="btn btn-sm">
              {t("artifacts.retry")}
            </button>
          </div>
        ) : items.length === 0 ? (
          <section
            data-testid="artifacts-empty"
            className="rounded-card border border-subtle bg-surface p-5"
          >
            <h2 className="text-sm font-semibold">{t("artifacts.emptyTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("artifacts.emptyBody")}</p>
          </section>
        ) : (
          <ul aria-label={t("artifacts.listLabel")} className="flex flex-col gap-1.5">
            {items.map((artifact) => (
              <li key={artifact.id}>
                <Link
                  to={`/artifacts/${artifact.id}`}
                  data-testid="artifact-item"
                  aria-label={t("artifacts.open", { title: artifact.title })}
                  className="flex flex-col gap-1 rounded-row border border-subtle bg-surface px-3 py-2 hover:bg-hover focus-visible:bg-hover"
                >
                  <span data-testid="artifact-title" className="truncate text-sm font-medium">
                    {artifact.title}
                  </span>
                  <span data-testid="artifact-meta" className="text-xs text-muted">
                    {t("artifacts.meta", {
                      size: formatBytes(artifact.bytes, locale),
                      date: formatArtifactDate(artifact.createdAt, locale),
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
