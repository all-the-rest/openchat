/**
 * Dictation controls, limits and errors.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const dictation = {
  "dictation.start": msg({ id: "dictation.start", message: "Start dictation" }),
  "dictation.stop": msg({ id: "dictation.stop", message: "Stop recording" }),
  "dictation.cancel": msg({ id: "dictation.cancel", message: "Cancel recording" }),
  "dictation.recording": msg({ id: "dictation.recording", message: "Recording" }),
  "dictation.requesting": msg({ id: "dictation.requesting", message: "Requesting microphone…" }),
  "dictation.transcribing": msg({ id: "dictation.transcribing", message: "Transcribing…" }),
  "dictation.retry": msg({ id: "dictation.retry", message: "Retry transcription" }),
  "dictation.elapsed": msg({ id: "dictation.elapsed", message: "Elapsed {duration}" }),
  "dictation.level": msg({ id: "dictation.level", message: "Input level" }),
  "dictation.limit.time": msg({ id: "dictation.limit.time", message: "Recording stopped at the {duration} limit." }),
  "dictation.limit.size": msg({ id: "dictation.limit.size", message: "Recording stopped at the {size} limit." }),
  "dictation.error.permission": msg({ id: "dictation.error.permission", message: "Microphone access was denied. Allow the microphone in your browser settings and try again." }),
  "dictation.error.noDevice": msg({ id: "dictation.error.noDevice", message: "No microphone was found. Connect an input device and try again." }),
  "dictation.error.unsupported": msg({ id: "dictation.error.unsupported", message: "This browser cannot record audio in a format the service accepts. Try a different browser." }),
  "dictation.error.tooLarge": msg({ id: "dictation.error.tooLarge", message: "The recording is too large. Record a shorter message." }),
  "dictation.error.unavailable": msg({ id: "dictation.error.unavailable", message: "The transcription service is unavailable. Try again later." }),
  "dictation.error.timeout": msg({ id: "dictation.error.timeout", message: "The transcription service timed out. Try again." }),
  "dictation.error.failed": msg({ id: "dictation.error.failed", message: "The recording could not be transcribed. Try again." }),
  "dictation.error.empty": msg({ id: "dictation.error.empty", message: "No speech was recognized. Try recording again." }),
  "dictation.error.network": msg({ id: "dictation.error.network", message: "The transcription service could not be reached. Check your connection and try again." }),
} as const
