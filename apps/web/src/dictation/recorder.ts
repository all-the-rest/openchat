/**
 * MediaRecorder, AudioContext and timer plumbing for dictation. The state
 * machine in `useDictation` owns React state; this module owns the browser
 * objects so teardown is one call and cannot be forgotten on a path change.
 */
import { baseMimeType } from "./format"

export interface RecordingSession {
  stream: MediaStream
  recorder: MediaRecorder
  mimeType: string
  chunks: Blob[]
  bytes: number
  startedAt: number
  analyser: AnalyserNode | null
  audioContext: AudioContext | null
  timer: number | null
  discard: boolean
  limitHit: boolean
}

export function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function closeContext(context: AudioContext | null): void {
  if (!context) return
  void context.close().catch(() => undefined)
}

export function clearTimer(session: RecordingSession): void {
  if (session.timer === null) return
  window.clearInterval(session.timer)
  session.timer = null
}

/** Stops capture and every device handle. Safe to call more than once. */
export function teardownSession(session: RecordingSession): void {
  clearTimer(session)
  try {
    if (session.recorder.state !== "inactive") session.recorder.stop()
  } catch {
    // A recorder that already stopped is fine; the tracks are stopped below.
  }
  stopTracks(session.stream)
  closeContext(session.audioContext)
  session.audioContext = null
  session.analyser = null
}

/** Best-effort level meter; recording works when AudioContext is unavailable. */
export function attachMeter(session: RecordingSession): void {
  const scope = globalThis as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const AudioContextCtor = scope.AudioContext ?? scope.webkitAudioContext
  if (!AudioContextCtor) return
  try {
    const context = new AudioContextCtor()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    context.createMediaStreamSource(session.stream).connect(analyser)
    session.audioContext = context
    session.analyser = analyser
  } catch {
    // Optional; the pill still shows elapsed time.
  }
}

/** RMS of the current time-domain window, scaled to 0 … 1. */
export function readLevel(analyser: AnalyserNode): number {
  const samples = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(samples)
  let sum = 0
  for (const sample of samples) {
    const normalized = (sample - 128) / 128
    sum += normalized * normalized
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3)
}

export function recordedBlob(session: RecordingSession): Blob {
  return new Blob(session.chunks, { type: baseMimeType(session.mimeType) })
}
