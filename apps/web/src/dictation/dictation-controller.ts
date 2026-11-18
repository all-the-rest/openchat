import type { DictationInfo } from "@openchat/contracts"
import type { DictationErrorCode } from "./errors"
import type { LocalProgress } from "./local-protocol"

export type DictationStatus = "idle" | "requesting" | "recording" | "transcribing" | "error"
export type DictationPath = "local" | "server"

export interface DictationNotice {
  kind: "time" | "size"
  /** Formatted limit, already localized by the caller. */
  value: string
}

export interface UseDictationOptions {
  config: DictationInfo | null | undefined
  /** BCP-47 tag sent as `?language=`; the local pipeline uses it too. */
  language: string
  onTranscript(text: string): void
}

export interface DictationController {
  enabled: boolean
  /** Which path is active; the UI labels it explicitly. */
  path: DictationPath
  serverAvailable: boolean
  consentPending: boolean
  progress: LocalProgress | null
  status: DictationStatus
  elapsedMs: number
  /** Normalized RMS level, 0 … 1. */
  level: number
  error: DictationErrorCode | null
  notice: DictationNotice | null
  press(): void
  release(): void
  toggle(): void
  stop(): void
  cancel(): void
  retry(): void
  dismiss(): void
  chooseLocal(): void
  chooseServer(): void
  decline(): void
  forgetModel(): Promise<void>
}
