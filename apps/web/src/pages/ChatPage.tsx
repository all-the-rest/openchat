import { useEffect, useRef } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { Composer } from "../chat/Composer"
import { ConnectionNotice } from "../chat/ConnectionNotice"
import { useSessions } from "../chat/sessions"
import { Transcript } from "../chat/Transcript"
import { useChatSession } from "../chat/useChatSession"
import { ErrorBanner } from "../components/ErrorBanner"
import type { MessageKey } from "../i18n"
import { useT } from "../i18n/provider"

interface ChatLocationState {
  pendingPrompt?: unknown
}

export function ChatPage() {
  const t = useT()
  const { sessionId = "", messageId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { sessions } = useSessions()
  const chat = useChatSession(sessionId)
  const consumedFor = useRef<string | null>(null)

  const session = sessions.find((entry) => entry.id === sessionId)
  const title = session?.title || t("session.untitled")

  const pendingPrompt = (location.state as ChatLocationState | null)?.pendingPrompt

  useEffect(() => {
    if (consumedFor.current === sessionId) return
    if (typeof pendingPrompt !== "string" || pendingPrompt.trim().length === 0) return
    if (chat.loading) return

    consumedFor.current = sessionId
    navigate(location.pathname, { replace: true, state: null })
    void chat.send(pendingPrompt).catch(() => undefined)
  }, [pendingPrompt, sessionId, chat, navigate, location.pathname])

  const statusKey: MessageKey = chat.queued
    ? "chat.statusQueued"
    : chat.submitting
      ? "chat.statusSubmitting"
      : chat.streaming
        ? "chat.statusStreaming"
        : chat.stopped || chat.lastAssistantStatus === "stopped"
          ? "chat.statusStopped"
          : chat.lastAssistantStatus === "error"
            ? "chat.statusError"
            : "chat.statusReady"

  const canRecover = !chat.loading && !chat.running

  const bannerMessage =
    chat.error === "send"
      ? t("chat.sendFailed")
      : chat.error === "stop"
        ? t("chat.stopFailed")
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-subtle bg-app px-4">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      </header>

      <Transcript
        messages={chat.messages}
        loading={chat.loading}
        failed={chat.error === "load"}
        onRetry={() => void chat.reload()}
        highlightMessageID={messageId}
        onContinue={canRecover ? () => void chat.continueRun() : undefined}
        onRetryLast={canRecover && chat.canRetry ? () => void chat.retryLast() : undefined}
      />

      <div className="shrink-0 border-t border-subtle bg-app px-4 pb-3 pt-3">
        <div className="mx-auto w-full max-w-[768px]">
          <ConnectionNotice />
          {bannerMessage ? (
            <ErrorBanner message={bannerMessage} onDismiss={chat.clearError} />
          ) : null}

          <Composer
            onSend={chat.send}
            onStop={() => void chat.stop()}
            running={chat.running}
            draftKey={sessionId}
          />

          <p
            role="status"
            aria-live="polite"
            data-testid="chat-status"
            className="mt-1 px-2 text-xs text-muted"
          >
            {t(statusKey)}
          </p>
          {chat.queued ? (
            <p className="px-2 text-xs text-muted">{t("chat.queuedHint")}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
