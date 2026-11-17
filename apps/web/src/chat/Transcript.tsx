import type { Message } from "@openchat/contracts"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowDownIcon } from "../components/icons"
import { useT } from "../i18n/provider"
import { MessageItem } from "./MessageItem"

export interface TranscriptProps {
  messages: Message[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** Shown under the last assistant message when it is not streaming. */
  onContinue?: () => void
  onRetryLast?: () => void
  /** Deep link target: scrolls there and marks the message. */
  highlightMessageID?: string
}

const PIN_THRESHOLD = 64

export function Transcript({
  messages,
  loading,
  failed,
  onRetry,
  onContinue,
  onRetryLast,
  highlightMessageID,
}: TranscriptProps) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)
  const [completed, setCompleted] = useState(false)
  const previousStreaming = useRef<Set<string>>(new Set())

  const anyStreaming = messages.some((message) => message.status === "streaming")

  let lastAssistantID: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant") {
      lastAssistantID = message.id
      break
    }
  }

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    // Instant scroll; reduced motion is the default for a chat transcript.
    element.scrollTop = element.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }, [])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance < PIN_THRESHOLD
    if (next !== pinnedRef.current) {
      pinnedRef.current = next
      setPinned(next)
    }
  }, [])

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [messages, scrollToBottom])

  const scrolledHighlight = useRef<string | null>(null)

  // A deep link scrolls once, when the target first exists. Repeating it on
  // every message change would pin the reader to the linked message while the
  // rest of the session keeps streaming.
  useEffect(() => {
    if (!highlightMessageID || scrolledHighlight.current === highlightMessageID) return
    const element = document.getElementById(`message-${highlightMessageID}`)
    if (!element) return
    scrolledHighlight.current = highlightMessageID
    element.scrollIntoView({ block: "center" })
    // Moving focus rather than only drawing a ring: a keyboard or screen-reader
    // user activating a search hit must land on what they followed.
    element.focus({ preventScroll: true })
    pinnedRef.current = false
    setPinned(false)
  }, [highlightMessageID, messages])

  const lastMessage = messages[messages.length - 1]
  useEffect(() => {
    if (lastMessage?.role === "user") scrollToBottom()
  }, [lastMessage?.id, lastMessage?.role, scrollToBottom])

  useEffect(() => {
    const current = new Set(
      messages.filter((message) => message.status === "streaming").map((message) => message.id),
    )
    let finished = false
    for (const id of previousStreaming.current) {
      if (!current.has(id)) finished = true
    }
    const started = current.size > 0 && previousStreaming.current.size === 0
    previousStreaming.current = current
    if (finished) setCompleted(true)
    else if (started) setCompleted(false)
  }, [messages])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="transcript"
        role="log"
        aria-label={t("chat.transcript")}
        aria-live={anyStreaming ? "off" : "polite"}
        aria-relevant="additions text"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <h2 className="sr-only">{t("chat.transcript")}</h2>
        <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-4 py-6">
          {loading ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <div className="skeleton h-4 w-2/3" />
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton h-4 w-3/5" />
            </div>
          ) : failed ? (
            <div className="flex flex-col items-start gap-2 text-sm text-secondary">
              <p>{t("chat.loadFailed")}</p>
              <button type="button" onClick={onRetry} className="btn btn-sm">
                {t("chat.retry")}
              </button>
            </div>
          ) : messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">{t("chat.empty")}</p>
          ) : (
            messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                highlighted={message.id === highlightMessageID}
                onContinue={
                  !anyStreaming && message.role === "assistant" && message.id === lastAssistantID
                    ? onContinue
                    : undefined
                }
                onRetry={
                  !anyStreaming && message.role === "assistant" && message.id === lastAssistantID
                    ? onRetryLast
                    : undefined
                }
              />
            ))
          )}
        </div>
      </div>

      {!pinned ? (
        <button
          type="button"
          data-testid="jump-latest"
          onClick={scrollToBottom}
          aria-label={t("chat.jumpToLatest")}
          title={t("chat.jumpToLatest")}
          className="btn btn-circle btn-sm absolute bottom-4 left-1/2 -translate-x-1/2 border border-subtle bg-elevated shadow-md"
        >
          <ArrowDownIcon className="size-4" />
        </button>
      ) : null}

      <span role="status" aria-live="polite" className="sr-only">
        {completed ? t("chat.answerComplete") : ""}
      </span>
    </div>
  )
}
