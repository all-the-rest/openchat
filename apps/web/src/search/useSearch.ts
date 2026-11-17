import { useCallback, useEffect, useRef, useState } from "react"
import { SEARCH_SOURCES } from "@openchat/contracts"
import type { SearchResponse, SearchSource } from "@openchat/contracts"
import { api } from "../api/client"

export type SearchStatus = "idle" | "loading" | "ready" | "error"

/** Waits this long after a keystroke before querying the BFF. */
const SEARCH_DEBOUNCE_MS = 250

export interface SearchController {
  /** Sources this deployment can query, from the last response. */
  available: SearchSource[]
  status: SearchStatus
  response: SearchResponse | null
  /** Confirms the current query, which is what makes `web` explicit. */
  submit: () => void
  retry: () => void
  /** True while the typed query differs from the committed one. */
  uncommitted: boolean
}

/**
 * Debounced search over `/api/search`.
 *
 * The query and the source selection are owned by the page (the query lives in
 * the URL), so this hook only turns them into requests. An in-flight request is
 * aborted when either changes, so an older answer can never overwrite a newer
 * one. The selection is never widened: a source the host does not have is
 * dropped from the request, not from the user's choice.
 *
 * `web` leaves the BFF only for a query the user committed (Enter, or a query
 * that arrived in the URL), never for a half-typed one.
 */
export function useSearch(
  query: string,
  selected: readonly SearchSource[],
): SearchController {
  const trimmed = query.trim()
  const [available, setAvailable] = useState<SearchSource[]>([...SEARCH_SOURCES])
  const [status, setStatus] = useState<SearchStatus>("idle")
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [committed, setCommitted] = useState(trimmed)
  const availableRef = useRef(available)
  availableRef.current = available
  const selectionKey = selected.join(",")

  useEffect(() => {
    if (trimmed.length === 0) {
      setStatus("idle")
      setResponse(null)
      return
    }
    // Read availability here rather than making it an effect dependency: a
    // response that narrows the source list must not trigger another query,
    // while Retry and Enter still use what is available now.
    const sources = selected.filter(
      (source) =>
        availableRef.current.includes(source) && (source !== "web" || committed === trimmed),
    )
    if (sources.length === 0) {
      setStatus("idle")
      setResponse(null)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setStatus("loading")
      api
        .search({ query: trimmed, sources, limit: 20, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          setAvailable(result.available)
          setResponse(result)
          setStatus("ready")
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setStatus("error")
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // `selectionKey` covers the selection without depending on array identity.
  }, [trimmed, selectionKey, committed, attempt])

  const submit = useCallback(() => {
    setCommitted(trimmed)
    setAttempt((value) => value + 1)
  }, [trimmed])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  return {
    available,
    status,
    response,
    submit,
    retry,
    uncommitted: trimmed.length > 0 && committed !== trimmed,
  }
}
