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
import { DictationButton } from "../dictation/DictationButton"
import { DictationFeedback } from "../dictation/DictationFeedback"
import { RecordingPill } from "../dictation/RecordingPill"
import { useDictation } from "../dictation/useDictation"
import { useDictationConfig } from "../dictation/useDictationConfig"

export interface ComposerProps {
  onSend(text: string): Promise<void> | void
  onStop(): void
  running: boolean
  disabled?: boolean
  autoFocus?: boolean
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
  dictation: dictationOverride,
}: ComposerProps) {
  const t = useT()
  const { locale } = useI18n()
  const [value, setValue] = useState("")
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  const caretRef = useRef<number | null>(null)

  valueRef.current = value

  const remoteDictation = useDictationConfig(dictationOverride === undefined)
  const dictationConfig = dictationOverride === undefined ? remoteDictation : dictationOverride

  /** Inserts at the caret without sending; the draft stays editable. */
  const insertAtCaret = useCallback((text: string) => {
    if (!text) return
    const element = textareaRef.current
    const current = valueRef.current
    const start = element?.selectionStart ?? current.length
    const end = element?.selectionEnd ?? start
    const next = current.slice(0, start) + text + current.slice(end)
    valueRef.current = next
    caretRef.current = start + text.length
    setValue(next)
  }, [])

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
    const text = value.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text)
      setValue("")
    } catch {
      // Keep the draft so a failed request never loses the prompt.
    } finally {
      setSending(false)
    }
  }, [value, sending, onSend])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(event.target.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
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
            disabled={disabled || value.trim().length === 0}
            aria-label={t("composer.send")}
            title={t("composer.send")}
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
      <p className="px-2 pt-1.5 text-xs text-muted">{t("composer.hint")}</p>
    </div>
  )
}
