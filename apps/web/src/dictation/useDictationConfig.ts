import { useEffect, useState } from "react"
import type { DictationInfo } from "@openchat/contracts"
import { api } from "../api/client"

let cached: DictationInfo | null = null
let pending: Promise<DictationInfo | null> | null = null

/**
 * Reads the dictation capability from `GET /api/info` once per page. A missing
 * or failed answer means "dictation is off": the composer then renders no
 * microphone control, and no microphone permission is ever requested.
 */
export function loadDictationInfo(): Promise<DictationInfo | null> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = (async () => {
      try {
        const info = await api.info()
        const dictation = info?.dictation
        if (dictation && typeof dictation.enabled === "boolean") return dictation
        return null
      } catch {
        return null
      }
    })().then((value) => {
      pending = null
      if (value) cached = value
      return value
    })
  }
  return pending
}

/**
 * Loads the capability only when `active`; callers that pass an explicit
 * configuration (tests) skip the request entirely.
 */
export function useDictationConfig(active = true): DictationInfo | null {
  const [config, setConfig] = useState<DictationInfo | null>(() => (active ? cached : null))

  useEffect(() => {
    if (!active) {
      setConfig(null)
      return
    }
    if (cached) {
      setConfig(cached)
      return
    }
    let mounted = true
    void loadDictationInfo().then((value) => {
      if (mounted) setConfig(value)
    })
    return () => {
      mounted = false
    }
  }, [active])

  return config
}
