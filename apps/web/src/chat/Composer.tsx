import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react"
import { useT } from "../i18n/provider"
import { SendIcon, StopIcon } from "../components/icons"

export interface ComposerProps {
  onSend(text: string): Promise<void> | void
  onStop(): void
  running: boolean
  disabled?: boolean
  autoFocus?: boolean
}

const MAX_HEIGHT = 8 * 24

export function Composer({ onSend, onStop, running, disabled = false, autoFocus = false }: ComposerProps) {
  const t = useT()
  const [value, setValue] = useState("")
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = "auto"
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
    }
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

  return (
    <div className="w-full">
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
      <p className="px-2 pt-1.5 text-xs text-muted">{t("composer.hint")}</p>
    </div>
  )
}
