import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { SEARCH_SOURCES } from "@openchat/contracts"
import type { SearchSource } from "@openchat/contracts"
import { SearchIcon } from "../components/icons"
import { useT } from "../i18n/provider"
import { SearchResults } from "./SearchResults"
import { SOURCE_LABEL } from "./sources"
import { useSearch } from "./useSearch"

/** `scope=all` is the multi-source surface; bare `/search` stays chat-only. */
function initialSelection(scope: string | null): SearchSource[] {
  return scope === "all" ? [...SEARCH_SOURCES] : ["chats"]
}

/**
 * `/search?scope=all&q=…` — one query, grouped by source (spec 02).
 *
 * `q` lives in the URL, so the input is derived from it: typing writes the URL,
 * reloading restores the query, and a shared link works. The source selection
 * stays local; a source the host cannot query is disabled, never dropped from
 * the user's choice behind their back.
 */
export function SearchPage() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const query = params.get("q") ?? ""
  const [selected, setSelected] = useState<SearchSource[]>(() =>
    initialSelection(params.get("scope")),
  )
  const search = useSearch(query, selected)
  const resultsRef = useRef<HTMLDivElement>(null)

  // `scope` is part of the URL, so a same-route change (sidebar entry,
  // address bar) applies the new preset. Toggling never rewrites `scope`.
  const scope = params.get("scope")
  useEffect(() => {
    setSelected(initialSelection(scope))
  }, [scope])

  const setQuery = (value: string) => {
    const next = new URLSearchParams(params)
    if (value.trim().length === 0) next.delete("q")
    else next.set("q", value)
    setParams(next, { replace: true })
  }

  const toggle = (source: SearchSource) => {
    setSelected((previous) => {
      if (previous.includes(source)) {
        // Never leave the fieldset empty: with no source there is nothing to
        // query and the user would just see an empty result page.
        if (previous.length === 1) return previous
        return previous.filter((entry) => entry !== source)
      }
      // Keep the canonical order so toggling never reorders the groups.
      return SEARCH_SOURCES.filter((entry) => entry === source || previous.includes(entry))
    })
  }

  const requestable = selected.filter((source) => search.available.includes(source))
  const canToggleOff = (source: SearchSource) =>
    requestable.includes(source) ? requestable.length > 1 : true

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown") return
    const first = resultsRef.current?.querySelector<HTMLElement>("[data-search-result]")
    if (!first) return
    event.preventDefault()
    first.focus()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t("search.title")}</h1>
          <p className="text-sm text-muted">{t("search.description")}</p>
        </header>

        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            search.submit()
          }}
        >
          <label htmlFor="search-query" className="sr-only">
            {t("search.label")}
          </label>
          <div className="relative flex items-center rounded-composer border border-strong bg-surface focus-within:border-focus-ring">
            <SearchIcon className="pointer-events-none absolute start-3 size-4 text-muted" />
            <input
              id="search-query"
              name="q"
              type="search"
              autoFocus
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t("search.placeholder")}
              className="w-full bg-transparent py-2.5 ps-10 pe-3 text-sm outline-none placeholder:text-muted"
            />
          </div>
          {search.uncommitted && selected.includes("web") && search.available.includes("web") ? (
            <p className="mt-1 text-xs text-muted">{t("search.webHint")}</p>
          ) : null}
        </form>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted">
            {t("search.sources")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {SEARCH_SOURCES.map((source) => {
              const available = search.available.includes(source)
              const checked = available && selected.includes(source)
              return (
                <label
                  key={source}
                  title={
                    available && !canToggleOff(source) ? t("search.lastSource") : undefined
                  }
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                    available
                      ? "border-subtle bg-surface"
                      : "border-subtle bg-surface text-muted opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs"
                    checked={checked}
                    disabled={!available || (checked && !canToggleOff(source))}
                    onChange={() => toggle(source)}
                    data-testid={`search-source-${source}`}
                  />
                  <span>{t(SOURCE_LABEL[source])}</span>
                  {!available ? (
                    <span className="text-muted">({t("search.unavailable")})</span>
                  ) : null}
                </label>
              )
            })}
          </div>
        </fieldset>

        {query.trim().length > 0 && requestable.length === 0 ? (
          <p className="text-sm text-muted">{t("search.noSources")}</p>
        ) : (
          <SearchResults
            resultsRef={resultsRef}
            status={search.status}
            response={search.response}
            query={query}
            onRetry={search.retry}
          />
        )}
      </div>
    </div>
  )
}
