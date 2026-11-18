import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react"
import type { DictationInfo } from "@openchat/contracts"
import { useI18n, useT } from "../i18n/provider"
import { SendIcon, StopIcon } from "../components/icons"
import { HOST_BANNER_ID } from "../components/HostStatusBanner"
import { useSurfaceOrNull } from "../code/SurfaceProvider"
import { DictationButton } from "../dictation/DictationButton"
import { DictationFeedback } from "../dictation/DictationFeedback"
import { RecordingPill } from "../dictation/RecordingPill"
import { useDictation } from "../dictation/useDictation"
import { useDictationConfig } from "../dictation/useDictationConfig"
import { useMediaQuery } from "../lib/useMediaQuery"
import { readDraft, writeDraft } from "./drafts"

export interface ComposerProps {
  onSend(text: string): Promise<void> | void
  onStop(): void
  running: boolean
  disabled?: boolean
  autoFocus?: boolean
  /**
   * Session id whose draft is kept in `sessionStorage` (spec 13: switching
   * surfaces must not lose the prompt). Omitted means component-local only.
   */
  draftKey?: string
  /** Explicit capability override; omitted means "read `GET /api/info`". */
  dictation?: DictationInfo | null
}

const MAX_HEIGHT = 8 * 24

export function Composer({
  onSend,
  onStop,
  running,
  disabled = false,
  autoFocus = false,
  draftKey,
  dictation: dictationOverride,
}: ComposerProps) {
  const t = useT()
  const { locale } = useI18n()
  // The shell's banner explains the outage; here it only disables the send
  // path. Keep the textarea usable so the draft is not lost.
  const hostUnreachable = useSurfaceOrNull()?.hostReachable === false
  const [value, setValue] = useState(() => (draftKey ? readDraft(draftKey) : ""))
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  const caretRef = useRef<number | null>(null)
  // Phones have no Enter key; the keyboard hint would only describe a gesture
  // the device cannot perform.
  const coarsePointer = useMediaQuery("(pointer: coarse)")

  valueRef.current = value

  /** Every write goes through here so the stored draft never lags the field. */
  const updateValue = useCallback(
    (next: string) => {
      valueRef.current = next
      setValue(next)
      if (draftKey) writeDraft(draftKey, next)
    },
    [draftKey],
  )

  // A route change from /c/one to /c/two reuses the composer; load that
  // session's draft instead of carrying the other chat's text over.
  useEffect(() => {
    if (!draftKey) return
    const next = readDraft(draftKey)
    valueRef.current = next
    setValue(next)
  }, [draftKey])

  const remoteDictation = useDictationConfig(dictationOverride === undefined)
  const dictationConfig = dictationOverride === undefined ? remoteDictation : dictationOverride

  /** Inserts at the caret without sending; the draft stays editable. */
  const insertAtCaret = useCallback(
    (text: string) => {
      if (!text) return
      const element = textareaRef.current
      const current = valueRef.current
      const start = element?.selectionStart ?? current.length
      const end = element?.selectionEnd ?? start
      const next = current.slice(0, start) + text + current.slice(end)
      caretRef.current = start + text.length
      updateValue(next)
    },
    [updateValue],
  )

  const dictation = useDictation({
    config: dictationConfig,
    language: locale,
    onTranscript: insertAtCaret,
  })

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = "auto"
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
    }
  }, [value])

  // A transcript keeps the composer focused and leaves the caret after the text.
  useEffect(() => {
    const position = caretRef.current
    if (position === null) return
    caretRef.current = null
    const element = textareaRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(position, position)
  }, [value])

  const submit = useCallback(async () => {
    if (hostUnreachable) return
    const text = value.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text)
      // Sent: the draft is consumed. A failure keeps it (and its stored copy).
      updateValue("")
    } catch {
      // Keep the draft so a failed request never loses the prompt.
    } finally {
      setSending(false)
    }
  }, [hostUnreachable, value, sending, onSend, updateValue])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    updateValue(event.target.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    // While the host is down Enter edits the draft (a newline) instead of
    // firing a request that cannot succeed.
    if (hostUnreachable) return
    event.preventDefault()
    void submit()
  }

  const recording = dictation.status === "recording" || dictation.status === "requesting"

  return (
    <div className="w-full">
      {recording ? (
        <RecordingPill
          elapsedMs={dictation.elapsedMs}
          level={dictation.level}
          requesting={dictation.status === "requesting"}
          onStop={dictation.stop}
          onCancel={dictation.cancel}
        />
      ) : null}
      <div className="flex items-end gap-2 rounded-composer border border-strong bg-surface ps-4 pe-2 py-2 focus-within:border-focus-ring">
        <textarea
          ref={textareaRef}
          data-testid="composer"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label={t("composer.label")}
          placeholder={t("composer.placeholder")}
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-6 text-base-content outline-none placeholder:text-muted"
        />
        <div className="flex items-center gap-1">
          {dictation.enabled ? <DictationButton dictation={dictation} /> : null}
          {running ? (
            <button
              type="button"
              data-testid="stop"
              onClick={onStop}
              aria-label={t("composer.stop")}
              title={t("composer.stop")}
              className="btn btn-ghost btn-circle"
            >
              <StopIcon className="size-5" />
            </button>
          ) : null}
          <button
            type="button"
            data-testid="send"
            onClick={() => void submit()}
            disabled={disabled || hostUnreachable || value.trim().length === 0}
            aria-describedby={hostUnreachable ? HOST_BANNER_ID : undefined}
            aria-label={t("composer.send")}
            title={hostUnreachable ? t("host.unreachable") : t("composer.send")}
            className="btn btn-primary btn-circle"
          >
            {sending ? (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            ) : (
              <SendIcon className="size-5" />
            )}
          </button>
        </div>
      </div>
      {dictation.enabled ? <DictationFeedback dictation={dictation} /> : null}
      {coarsePointer ? null : (
        <p className="px-2 pt-1.5 text-xs text-muted">{t("composer.hint")}</p>
      )}
    </div>
  )
}
