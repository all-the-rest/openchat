import { messageText, type Message } from "@openchat/contracts"
import { useEffect, useId, useRef, useState } from "react"
import { CopyIcon } from "../components/icons"
import { useT } from "../i18n/provider"
import { copyText } from "../lib/clipboard"
import { MessagePart } from "../render/MessagePart"

function MessageActions({
  message,
  align,
  onContinue,
  onRetry,
}: {
  message: Message
  align: "start" | "end"
  onContinue?: () => void
  onRetry?: () => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [])

  const copy = async () => {
    const ok = await copyText(messageText(message))
    if (!ok) return
    setCopied(true)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`flex items-center gap-1 ${align === "end" ? "justify-end" : ""}`.trim()}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t("chat.copyMessage")}
        title={t("chat.copyMessage")}
        className="btn btn-ghost btn-xs btn-square text-muted"
      >
        <CopyIcon className="size-3.5" />
      </button>
      {onContinue ? (
        <button type="button" onClick={onContinue} className="btn btn-ghost btn-xs">
          {t("chat.continue")}
        </button>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn btn-ghost btn-xs">
          {t("chat.retryLast")}
        </button>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("chat.copied") : ""}
      </span>
    </div>
  )
}

export function MessageItem({
  message,
  onContinue,
  onRetry,
}: {
  message: Message
  onContinue?: () => void
  onRetry?: () => void
}) {
  const t = useT()
  const headingID = useId()
  const streaming = message.status === "streaming"
  const isUser = message.role === "user"

  if (message.role === "system") {
    return (
      <p className="my-3 text-center text-xs text-muted">{messageText(message)}</p>
    )
  }

  return (
    <article
      data-testid={`message-${message.role}`}
      aria-labelledby={headingID}
      className="flex flex-col gap-1"
    >
      <h4 id={headingID} className="sr-only">
        {isUser ? t("chat.youSaid") : t("chat.assistantSaid")}
      </h4>

      {isUser ? (
        <div className="max-w-[85%] self-end rounded-bubble bg-bubble-user px-4 py-2.5 text-bubble-user-text">
          <div className="flex flex-col gap-1">
            {message.parts.map((part) =>
              part.type === "text" ? (
                <p key={part.id} className="whitespace-pre-wrap break-words text-base">
                  {part.text}
                </p>
              ) : (
                <MessagePart key={part.id} part={part} streaming={false} />
              ),
            )}
          </div>
        </div>
      ) : (
        <div className="flex w-full min-w-0 flex-col gap-2">
          {message.parts.map((part) => (
            <MessagePart key={part.id} part={part} streaming={streaming} />
          ))}
          {streaming ? (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-2 animate-pulse rounded-sm bg-current opacity-60 motion-reduce:animate-none"
            />
          ) : null}
        </div>
      )}

      <MessageActions
        message={message}
        align={isUser ? "end" : "start"}
        onContinue={isUser ? undefined : onContinue}
        onRetry={isUser ? undefined : onRetry}
      />
    </article>
  )
}
