import { type KeyboardEvent, type RefObject } from "react"
import { Link } from "react-router-dom"
import type { SearchGroup, SearchHit, SearchResponse } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import { SOURCE_LABEL, STATUS_LABEL } from "./sources"
import type { SearchStatus } from "./useSearch"

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function HitRow({ hit }: { hit: SearchHit }) {
  const t = useT()
  const statusLabel = hit.status ? STATUS_LABEL[hit.status] : undefined
  const title = <span className="truncate text-sm font-medium">{hit.title}</span>
  const snippet = hit.snippet ? (
    <span className="line-clamp-2 text-xs text-secondary">{hit.snippet}</span>
  ) : null
  const appLine = hit.app ? (
    <span className="truncate text-xs text-muted">
      {hit.appKind === "skill"
        ? t("search.kindSkill")
        : hit.appKind === "tool"
          ? t("search.kindTool")
          : t("search.kindServer")}
      {hit.status ? ` · ${statusLabel ? t(statusLabel) : hit.status}` : ""}
    </span>
  ) : null

  if (hit.source === "chats" && hit.sessionID) {
    // The ids come from the host; encode them so a stray character in an id
    // cannot change the path shape.
    const session = encodeURIComponent(hit.sessionID)
    const to = hit.messageID
      ? `/c/${session}/${encodeURIComponent(hit.messageID)}`
      : `/c/${session}`
    return (
      <Link
        to={to}
        data-search-result
        className="flex flex-col gap-0.5 rounded-row border border-subtle bg-surface px-3 py-2 hover:bg-hover"
      >
        {title}
        {snippet}
      </Link>
    )
  }

  if (hit.source === "web" && hit.url) {
    return (
      <a
        href={hit.url}
        target="_blank"
        rel="noreferrer noopener"
        data-search-result
        className="flex flex-col gap-0.5 rounded-row border border-subtle bg-surface px-3 py-2 hover:bg-hover"
      >
        {title}
        {snippet}
        <span className="truncate text-xs text-muted">
          {hit.provider ? `${hit.provider} · ` : ""}
          {hostOf(hit.url)}
          <span className="sr-only"> ({t("search.opensInNewTab")})</span>
        </span>
      </a>
    )
  }

  // An app hit points at the one surface where its status can be acted on.
  if (hit.source === "apps") {
    return (
      <Link
        to="/apps"
        data-search-result
        className="flex flex-col gap-0.5 rounded-row border border-subtle bg-surface px-3 py-2 hover:bg-hover"
      >
        {title}
        {snippet}
        {appLine}
      </Link>
    )
  }

  // Workspace hits stay informational until #11 (file view) exists.
  return (
    <div
      data-search-result
      tabIndex={-1}
      className="flex flex-col gap-0.5 rounded-row border border-subtle bg-surface px-3 py-2"
    >
      {title}
      {snippet}
      {hit.path && hit.path !== hit.title ? (
        <span className="truncate text-xs text-muted">{hit.path}</span>
      ) : null}
      {appLine}
    </div>
  )
}

function GroupSection({ group }: { group: SearchGroup }) {
  const t = useT()
  return (
    <section aria-label={t(SOURCE_LABEL[group.source])} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{t(SOURCE_LABEL[group.source])}</h2>
        {group.state === "ok" ? (
          <span className="text-xs text-muted">
            {t("search.groupCount", { count: group.hits.length })}
          </span>
        ) : (
          <span className="text-xs text-muted">
            {group.state === "failed" ? t("search.groupFailed") : t("search.groupDisabled")}
          </span>
        )}
      </div>
      {group.state === "disabled" ? (
        <p className="text-xs text-muted">{t("search.disabledHint")}</p>
      ) : null}
      {group.hits.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {group.hits.map((hit) => (
            <li key={`${hit.source}:${hit.id}`}>
              <HitRow hit={hit} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export interface SearchResultsProps {
  status: SearchStatus
  response: SearchResponse | null
  query: string
  onRetry: () => void
  resultsRef?: RefObject<HTMLDivElement | null>
}

export function SearchResults({
  status,
  response,
  query,
  onRetry,
  resultsRef,
}: SearchResultsProps) {
  const t = useT()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const nodes = Array.from(
      resultsRef?.current?.querySelectorAll<HTMLElement>("[data-search-result]") ?? [],
    )
    if (nodes.length === 0) return
    event.preventDefault()
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === "ArrowDown"
        ? nodes[Math.min(nodes.length - 1, index + 1)]
        : nodes[Math.max(0, index - 1)]
    next?.focus()
  }

  if (status === "idle" || query.trim().length === 0) {
    return <p className="py-6 text-sm text-muted">{t("search.prompt")}</p>
  }

  if (status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 py-4 text-sm">
        <p className="text-error">{t("search.failed")}</p>
        <button type="button" onClick={onRetry} className="btn btn-sm">
          {t("search.retry")}
        </button>
      </div>
    )
  }

  if (status === "loading" && !response) {
    return (
      <div className="flex flex-col gap-2 py-2" aria-hidden="true">
        <div className="skeleton h-4 w-1/3" />
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-12 w-full" />
      </div>
    )
  }

  if (!response) return null

  const total = response.groups.reduce((sum, group) => sum + group.hits.length, 0)
  // Groups are worth a heading when they carry hits or say something about the
  // query (failed/disabled). All-ok-and-empty groups would only repeat the
  // "no results" line once per source.
  const showGroups = response.groups.some(
    (group) => group.state !== "ok" || group.hits.length > 0,
  )

  return (
    <div
      ref={resultsRef}
      onKeyDown={onKeyDown}
      aria-busy={status === "loading"}
      className="flex flex-col gap-6"
    >
      <p className="text-xs text-muted" role="status" aria-live="polite">
        {total === 0
          ? t("search.noResults", { query: response.query })
          : t("search.resultCount", { count: total, query: response.query })}
      </p>
      {showGroups
        ? response.groups.map((group) => <GroupSection key={group.source} group={group} />)
        : null}
    </div>
  )
}
