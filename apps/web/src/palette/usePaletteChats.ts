import { useEffect, useState } from "react"
import type { SearchHit } from "@openchat/contracts"
import { api } from "../api/client"

export type PaletteSearchStatus = "idle" | "loading" | "ready" | "error"

/** Waits this long after a keystroke before querying the BFF. */
export const PALETTE_DEBOUNCE_MS = 200

export interface PaletteChatSearch {
  status: PaletteSearchStatus
  hits: SearchHit[]
}

/**
 * Debounced chat-only search for the palette. The sidebar stays the title
 * list; this is the global entry to message content. The BFF's `chats` group
 * already carries a bounded snippet, which is all the palette renders — the
 * transcript itself is never fetched here.
 */
export function usePaletteChats(query: string): PaletteChatSearch {
  const [status, setStatus] = useState<PaletteSearchStatus>("idle")
  const [hits, setHits] = useState<SearchHit[]>([])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setStatus("idle")
      setHits([])
      return
    }

    const controller = new AbortController()
    // Old hits belong to the old query; keeping them while the debounce runs
    // would show a result whose title no longer matches what is typed.
    setHits([])
    setStatus("loading")
    const timer = window.setTimeout(() => {
      api
        .search({ query: trimmed, sources: ["chats"], limit: 8, signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return
          const group = response.groups.find((entry) => entry.source === "chats")
          setHits(group?.state === "ok" ? group.hits : [])
          setStatus("ready")
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setHits([])
          setStatus("error")
        })
    }, PALETTE_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  return { status, hits }
}
