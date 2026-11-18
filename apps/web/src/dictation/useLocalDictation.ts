/**
 * Chooses between the on-device and the server transcription path and owns the
 * consent + cache lifecycle (issue #47). No weight byte is read until the
 * owner explicitly consents; a declined consent is remembered.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { STT_MODEL_CACHE_NAME, type DictationInfo } from "@openchat/contracts"
import {
  deleteLocalModel,
  isLocalModelCached,
  prepareLocalModel,
  writeConsent,
} from "./local-cache"
import {
  createLocalSession,
  type LocalProgress,
  type LocalResult,
  type LocalSession,
} from "./local-transcriber"

export interface LocalDictation {
  path: "local" | "server"
  serverAvailable: boolean
  consentPending: boolean
  modelReady: boolean
  progress: LocalProgress | null
  chooseLocal(): void
  chooseServer(): void
  decline(): void
  switchToServer(): void
  forgetModel(): Promise<void>
  run(audio: Blob, language: string): Promise<LocalResult>
  cancel(): void
}

export function useLocalDictation(config: DictationInfo | null | undefined): LocalDictation {
  const localAvailable = Boolean(config?.local?.available)
  const serverAvailable = config?.server?.available ?? !config?.local?.available
  const [decision, setDecision] = useState<string | null>(null)
  const [forcedServer, setForcedServer] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const [progress, setProgress] = useState<LocalProgress | null>(null)
  const sessionRef = useRef<LocalSession | null>(null)

  useEffect(() => {
    let mounted = true
    if (!localAvailable) {
      setDecision(null)
      setModelReady(false)
      return
    }
    void Promise.all([prepareLocalModel(), isLocalModelCached()]).then(([state, cached]) => {
      if (!mounted) return
      setDecision(state?.decision ?? null)
      setModelReady(cached)
    })
    return () => {
      mounted = false
    }
  }, [localAvailable])

  const path: "local" | "server" =
    localAvailable && !forcedServer && decision !== "server" && decision !== "declined"
      ? "local"
      : "server"
  const consentPending = path === "local" && !modelReady && decision === null

  const session = useCallback((): LocalSession => {
    if (!sessionRef.current) {
      sessionRef.current = createLocalSession(STT_MODEL_CACHE_NAME, {
        onReady: () => {
          setModelReady(true)
          setProgress(null)
        },
        onProgress: (value) => setProgress(value),
      })
    }
    return sessionRef.current
  }, [])

  const chooseLocal = useCallback(() => {
    writeConsent("accepted")
    setDecision("accepted")
    // Consent is explicit: only now may the first weight byte be requested.
    void session().load().catch(() => {
      sessionRef.current?.cancel()
      sessionRef.current = null
    })
  }, [session])

  const chooseServer = useCallback(() => {
    writeConsent("server")
    setDecision("server")
    setForcedServer(true)
    setProgress(null)
  }, [])

  const decline = useCallback(() => {
    writeConsent("declined")
    setDecision("declined")
    setProgress(null)
  }, [])

  const switchToServer = useCallback(() => {
    writeConsent("server")
    setDecision("server")
    setForcedServer(true)
    setProgress(null)
  }, [])

  const forgetModel = useCallback(async () => {
    sessionRef.current?.cancel()
    sessionRef.current = null
    await deleteLocalModel()
    setDecision(null)
    setForcedServer(false)
    setModelReady(false)
    setProgress(null)
  }, [])

  const run = useCallback(
    async (audio: Blob, language: string): Promise<LocalResult> => {
      try {
        return await session().transcribe(audio, language)
      } catch (failure) {
        sessionRef.current?.cancel()
        sessionRef.current = null
        throw failure
      }
    },
    [session],
  )

  const cancel = useCallback(() => {
    sessionRef.current?.cancel()
    sessionRef.current = null
    setProgress(null)
  }, [])

  return {
    path,
    serverAvailable,
    consentPending,
    modelReady,
    progress,
    chooseLocal,
    chooseServer,
    decline,
    switchToServer,
    forgetModel,
    run,
    cancel,
  }
}
