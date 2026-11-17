import { useCallback, useEffect, useRef, useState } from "react"
import type { DictationInfo } from "@openchat/contracts"
import { api } from "../api/client"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS } from "./config"
import { mapCaptureError, mapTranscribeError, type DictationErrorCode } from "./errors"
import { formatBytes, formatDuration, pickMimeType } from "./format"
import {
  attachMeter,
  clearTimer,
  readLevel,
  recordedBlob,
  stopTracks,
  teardownSession,
  type RecordingSession,
} from "./recorder"

export type DictationStatus = "idle" | "requesting" | "recording" | "transcribing" | "error"

export interface DictationNotice {
  kind: "time" | "size"
  /** Formatted limit, already localized by the caller. */
  value: string
}

export interface UseDictationOptions {
  config: DictationInfo | null | undefined
  /** BCP-47 tag sent as `?language=`; the STT service may ignore it. */
  language: string
  onTranscript(text: string): void
}

export interface DictationController {
  enabled: boolean
  status: DictationStatus
  elapsedMs: number
  /** Normalized RMS level, 0 … 1. */
  level: number
  error: DictationErrorCode | null
  notice: DictationNotice | null
  /** Pointer press; starts recording inside the gesture. */
  press(): void
  /** Pointer release; a short press keeps recording, a long press stops. */
  release(): void
  /** Keyboard toggle (Enter/Space) and a click that did not start capture. */
  toggle(): void
  stop(): void
  cancel(): void
  retry(): void
  dismiss(): void
}

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
      try {
        const result = await api.transcribe(blob, { language: languageRef.current })
        if (!mountedRef.current) return
        const text = typeof result?.text === "string" ? result.text.trim() : ""
        if (text.length === 0) {
          lastBlobRef.current = null
          setError("empty_transcript")
          updateStatus("error")
          return
        }
        lastBlobRef.current = null
        updateStatus("idle")
        onTranscriptRef.current(text)
      } catch (failure) {
        if (!mountedRef.current) return
        const code = mapTranscribeError(failure)
        // A 422 means this audio has no words in it; retrying the same bytes
        // can only return 422 again, so the retry records anew.
        if (code === "empty_transcript") lastBlobRef.current = null
        setError(code)
        updateStatus("error")
      }
    },
    [updateStatus],
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
      if (
        !session.limitHit &&
        session.recorder.state === "recording" &&
        elapsed >= limits.maxSeconds * 1000
      ) {
        session.limitHit = true
        setNotice({ kind: "time", value: formatDuration(limits.maxSeconds * 1000) })
        stopSession(session)
      }
    },
    [stopSession],
  )

  const begin = useCallback(async () => {
    if (!enabled) return
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
        // A replacement capture may already be running; it owns the clock and
        // the status now.
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
  }, [enabled, send, stopSession, tick, updateStatus])

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
  }, [updateStatus])

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

  // Escape cancels the recording before menus or the field see the key (spec 04).
  const cancelling = status === "recording" || status === "requesting"
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

  // Leaving the composer must not leave the microphone open.
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
  }
}
