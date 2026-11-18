import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react"
import { useT } from "../i18n/provider"
import { MicIcon } from "../components/icons"
import { HOLD_THRESHOLD_MS, type DictationController } from "./useDictation"

export interface DictationButtonProps {
  dictation: DictationController
}

/**
 * Microphone control. The permission request happens inside `pointerdown` or
 * `keydown`, never on mount. A short press latches hands-free, a long press
 * stops; the click that belongs to the starting press is ignored.
 */
export function DictationButton({ dictation }: DictationButtonProps) {
  const t = useT()
  const pressStartedAt = useRef(0)
  const { status } = dictation
  const busy = status === "requesting" || status === "transcribing"
  const label =
    status === "transcribing"
      ? t("dictation.transcribing")
      : status === "recording"
        ? t("dictation.stop")
        : t("dictation.start")

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    // Only a press that starts a capture owns the click that follows it.
    if (status === "idle" || status === "error") pressStartedAt.current = Date.now()
    const target = event.currentTarget
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is a convenience; the button still works without it.
      }
    }
    dictation.press()
  }

  const handlePointerUp = () => {
    dictation.release()
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Keyboard activation is handled in keydown so Enter and Space each toggle once.
    if (event.detail === 0) return
    // The click that belongs to a starting press must not toggle again. A
    // timestamp ages out, so a lost click cannot swallow a later stop click.
    if (Date.now() - pressStartedAt.current < HOLD_THRESHOLD_MS) {
      pressStartedAt.current = 0
      return
    }
    dictation.toggle()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Space") return
    event.preventDefault()
    if (event.repeat) return
    dictation.toggle()
  }

  return (
    <button
      type="button"
      data-testid="dictation"
      aria-label={label}
      aria-pressed={status === "recording"}
      aria-busy={busy || undefined}
      title={label}
      disabled={status === "transcribing"}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => dictation.cancel()}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onContextMenu={(event) => event.preventDefault()}
      // The idle mic carries the same soft surface as the send disc, so it
      // reads as a control rather than as decoration next to it (UI-8).
      className={`btn btn-circle min-h-9 min-w-9 touch-manipulation select-none ${
        status === "recording" ? "btn-ghost" : "btn-soft"
      }`}
    >
      {busy ? (
        <span className="loading loading-spinner loading-sm" aria-hidden="true" />
      ) : (
        <MicIcon className={status === "recording" ? "size-5 text-error" : "size-5"} />
      )}
    </button>
  )
}
