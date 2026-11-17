import type { MessageKey } from "../i18n"
import { ApiError } from "../api/client"

/** Every failure the dictation flow distinguishes in the UI. */
export type DictationErrorCode =
  | "permission"
  | "no_device"
  | "unsupported"
  | "too_large"
  | "unavailable"
  | "timeout"
  | "failed"
  | "empty_transcript"
  | "network"

export const ERROR_MESSAGE_KEYS: Record<DictationErrorCode, MessageKey> = {
  permission: "dictation.error.permission",
  no_device: "dictation.error.noDevice",
  unsupported: "dictation.error.unsupported",
  too_large: "dictation.error.tooLarge",
  unavailable: "dictation.error.unavailable",
  timeout: "dictation.error.timeout",
  failed: "dictation.error.failed",
  empty_transcript: "dictation.error.empty",
  network: "dictation.error.network",
}

function nameOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name: unknown }).name)
  }
  return ""
}

/** `getUserMedia` / `MediaRecorder` failures. */
export function mapCaptureError(error: unknown): DictationErrorCode {
  switch (nameOf(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission"
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no_device"
    case "NotSupportedError":
      return "unsupported"
    default:
      return "failed"
  }
}

/** BFF failures, keyed by the fixed error codes first and HTTP status second. */
export function mapTranscribeError(error: unknown): DictationErrorCode {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unsupported_media_type":
        return "unsupported"
      case "payload_too_large":
        return "too_large"
      case "stt_unavailable":
        return "unavailable"
      case "stt_timeout":
        return "timeout"
      case "empty_transcript":
        return "empty_transcript"
      case "stt_failed":
        return "failed"
      default:
        break
    }
    switch (error.status) {
      case 413:
        return "too_large"
      case 415:
        return "unsupported"
      case 422:
        return "empty_transcript"
      case 503:
        return "unavailable"
      case 504:
        return "timeout"
      default:
        return "failed"
    }
  }
  if (error instanceof TypeError) return "network"
  return "failed"
}
