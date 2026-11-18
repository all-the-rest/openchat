import { useCallback, useEffect, useRef, useState } from "react"
import type { DictationInfo } from "@openchat/contracts"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS } from "./config"
import type {
  DictationController,
  DictationNotice,
  DictationStatus,
  UseDictationOptions,
} from "./dictation-controller"
import { mapCaptureError, mapLocalError, mapTranscribeError, type DictationErrorCode } from "./errors"
import { formatBytes, formatDuration, pickMimeType } from "./format"
import { useLocalDictation } from "./useLocalDictation"
import {
  attachMeter,
  clearTimer,
  readLevel,
  recordedBlob,
  stopTracks,
  teardownSession,
  type RecordingSession,
} from "./recorder"
import { transcribeAudio } from "./transcribe-audio"

export type {
  DictationController,
  DictationNotice,
  DictationPath,
  DictationStatus,
  UseDictationOptions,
} from "./dictation-controller"

/** A press shorter than this keeps recording hands-free instead of stopping. */
export const HOLD_THRESHOLD_MS = 350
/** `dataavailable` timeslice; this is how the byte limit is enforced. */
const TIMESLICE_MS = 500
/** Elapsed clock and meter sample rate. */
const TICK_MS = 100

export function useDictation({ config, language, onTranscript }: UseDictationOptions): DictationController {
  const [status, setStatus] = useState<DictationStatus>("idle")
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<DictationErrorCode | null>(null)
  const [notice, setNotice] = useState<DictationNotice | null>(null)

  const statusRef = useRef<DictationStatus>("idle")
  const sessionRef = useRef<RecordingSession | null>(null)
  const tokenRef = useRef(0)
  const mountedRef = useRef(true)
  const pressedAtRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const lastBlobRef = useRef<Blob | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  const languageRef = useRef(language)
  const limitsRef = useRef({ maxSeconds: DEFAULT_MAX_SECONDS, maxBytes: DEFAULT_MAX_BYTES })

  onTranscriptRef.current = onTranscript
  languageRef.current = language
  const local = useLocalDictation(config)
  const enabled = Boolean(config?.enabled)
  limitsRef.current = {
    maxSeconds: config?.maxSeconds && config.maxSeconds > 0 ? config.maxSeconds : DEFAULT_MAX_SECONDS,
    maxBytes: config?.maxBytes && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES,
  }

  const updateStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const send = useCallback(
    async (blob: Blob) => {
      lastBlobRef.current = blob
      updateStatus("transcribing")
      setError(null)
      const outcome = await transcribeAudio(blob, languageRef.current, local)
      if (!mountedRef.current) return
      if (outcome.ok && outcome.text.length > 0) {
        lastBlobRef.current = null
        updateStatus("idle")
        onTranscriptRef.current(outcome.text)
        return
      }
      if (outcome.ok) {
        lastBlobRef.current = null
        setError("empty_transcript")
        updateStatus("error")
        return
      }
      const code = outcome.path === "local" ? mapLocalError(outcome.error) : mapTranscribeError(outcome.error)
      // Empty audio cannot become non-empty on retry; recording anew can.
      if (code === "empty_transcript") lastBlobRef.current = null
      setError(code)
      updateStatus("error")
    },
    [local, updateStatus],
  )

  const stopSession = useCallback(
    (session: RecordingSession) => {
      if (session.recorder.state === "inactive" || session.discard) return
      clearTimer(session)
      setLevel(0)
      updateStatus("transcribing")
      try {
        session.recorder.stop()
      } catch (failure) {
        sessionRef.current = null
        teardownSession(session)
        setError(mapCaptureError(failure))
        updateStatus("error")
      }
    },
    [updateStatus],
  )

  const tick = useCallback(
    (session: RecordingSession) => {
      if (!mountedRef.current) return
      const limits = limitsRef.current
      const elapsed = Date.now() - session.startedAt
      setElapsedMs(elapsed)
      if (session.analyser) setLevel(readLevel(session.analyser))
      if (!session.limitHit && session.recorder.state === "recording" && elapsed >= limits.maxSeconds * 1000) {
        session.limitHit = true
        setNotice({ kind: "time", value: formatDuration(limits.maxSeconds * 1000) })
        stopSession(session)
      }
    },
    [stopSession],
  )

  const begin = useCallback(async () => {
    if (!enabled || local.consentPending) return
    const token = ++tokenRef.current
    stopRequestedRef.current = false
    setError(null)
    setNotice(null)
    setElapsedMs(0)
    setLevel(0)
    updateStatus("requesting")

    const mimeType = pickMimeType()
    const mediaDevices = navigator.mediaDevices
    if (!mimeType || !mediaDevices?.getUserMedia) {
      setError("unsupported")
      updateStatus("error")
      return
    }
    let stream: MediaStream
    try {
      stream = await mediaDevices.getUserMedia({ audio: true })
    } catch (failure) {
      if (token !== tokenRef.current || !mountedRef.current) return
      setError(mapCaptureError(failure))
      updateStatus("error")
      return
    }
    if (token !== tokenRef.current || !mountedRef.current || stopRequestedRef.current) {
      stopRequestedRef.current = false
      stopTracks(stream)
      if (token === tokenRef.current && mountedRef.current) updateStatus("idle")
      return
    }
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch {
      stopTracks(stream)
      setError("unsupported")
      updateStatus("error")
      return
    }

    const session: RecordingSession = {
      stream,
      recorder,
      mimeType,
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      analyser: null,
      audioContext: null,
      timer: null,
      discard: false,
      limitHit: false,
    }
    sessionRef.current = session

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return
      const { maxBytes } = limitsRef.current
      // Never let the blob cross the cap: the BFF enforces the same limit and
      // would answer 413 for audio this client produced. The chunk that would
      // cross it is dropped; "what exists" is what was recorded so far. This
      // is a byte test only — the time limit also sets `limitHit`, and its
      // final chunk must still be kept.
      if (session.bytes + event.data.size > maxBytes) {
        if (!session.limitHit && recorder.state === "recording") {
          session.limitHit = true
          setNotice({ kind: "size", value: formatBytes(maxBytes) })
          stopSession(session)
        }
        return
      }
      session.chunks.push(event.data)
      session.bytes += event.data.size
    }

    recorder.onstop = () => {
      clearTimer(session)
      stopTracks(session.stream)
      if (session.audioContext) void session.audioContext.close().catch(() => undefined)
      session.audioContext = null
      session.analyser = null
      if (sessionRef.current === session) sessionRef.current = null
      if (!mountedRef.current) return
      if (session.discard) {
        if (sessionRef.current === null) {
          setLevel(0)
          setElapsedMs(0)
          updateStatus("idle")
        }
        return
      }
      setLevel(0)
      setElapsedMs(0)
      const blob = recordedBlob(session)
      if (blob.size === 0) {
        setError("empty_transcript")
        updateStatus("error")
        return
      }
      void send(blob)
    }

    try {
      recorder.start(TIMESLICE_MS)
    } catch (failure) {
      sessionRef.current = null
      teardownSession(session)
      setError(mapCaptureError(failure))
      updateStatus("error")
      return
    }
    session.startedAt = Date.now()
    attachMeter(session)
    session.timer = window.setInterval(() => tick(session), TICK_MS)
    updateStatus("recording")
  }, [enabled, local.consentPending, send, stopSession, tick, updateStatus])

  const press = useCallback(() => {
    if (!enabled) return
    const current = statusRef.current
    if (current === "recording" || current === "requesting" || current === "transcribing") return
    pressedAtRef.current = Date.now()
    void begin()
  }, [begin, enabled])

  const release = useCallback(() => {
    const pressedAt = pressedAtRef.current
    if (pressedAt === 0) return
    pressedAtRef.current = 0
    if (Date.now() - pressedAt < HOLD_THRESHOLD_MS) return
    const session = sessionRef.current
    if (session) stopSession(session)
    else stopRequestedRef.current = true
  }, [stopSession])

  const stop = useCallback(() => {
    const session = sessionRef.current
    if (session) stopSession(session)
  }, [stopSession])

  const cancel = useCallback(() => {
    tokenRef.current += 1
    pressedAtRef.current = 0
    stopRequestedRef.current = false
    lastBlobRef.current = null
    local.cancel()
    const session = sessionRef.current
    sessionRef.current = null
    if (session) {
      session.discard = true
      teardownSession(session)
    }
    setElapsedMs(0)
    setLevel(0)
    setError(null)
    setNotice(null)
    updateStatus("idle")
  }, [local.cancel, updateStatus])

  const toggle = useCallback(() => {
    if (!enabled) return
    const current = statusRef.current
    if (current === "recording") {
      const session = sessionRef.current
      if (session) stopSession(session)
      return
    }
    if (current === "requesting") {
      cancel()
      return
    }
    if (current === "transcribing") return
    void begin()
  }, [begin, cancel, enabled, stopSession])

  const retry = useCallback(() => {
    if (statusRef.current === "transcribing") return
    const blob = lastBlobRef.current
    if (blob) {
      void send(blob)
      return
    }
    void begin()
  }, [begin, send])

  const dismiss = useCallback(() => {
    lastBlobRef.current = null
    setError(null)
    if (statusRef.current === "error") updateStatus("idle")
  }, [updateStatus])

  const cancelling = status === "recording" || status === "requesting" || local.consentPending
  useEffect(() => {
    if (!cancelling) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener("keydown", handleEscape, true)
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [cancelling, cancel])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      tokenRef.current += 1
      const session = sessionRef.current
      sessionRef.current = null
      if (session) {
        session.discard = true
        teardownSession(session)
      }
    }
  }, [])

  return {
    enabled,
    path: local.path,
    serverAvailable: local.serverAvailable,
    consentPending: local.consentPending,
    progress: local.progress,
    status,
    elapsedMs,
    level,
    error,
    notice,
    press,
    release,
    toggle,
    stop,
    cancel,
    retry,
    dismiss,
    chooseLocal: local.chooseLocal,
    chooseServer: local.chooseServer,
    decline: local.decline,
    forgetModel: local.forgetModel,
  }
}
