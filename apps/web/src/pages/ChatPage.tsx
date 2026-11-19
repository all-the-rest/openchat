import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"
import { messageText, type Message } from "@openchat/contracts"
import { api } from "../api/client"
import { ChatFiles } from "../chat/ChatFiles"
import { ChatMenu } from "../chat/ChatMenu"
import { CompletionPickers } from "../chat/CompletionPicker"
import { Composer } from "../chat/Composer"
import { ConnectionNotice } from "../chat/ConnectionNotice"
import { ContextMeter } from "../chat/ContextMeter"
import { clearDraft } from "../chat/drafts"
import { PermissionCard } from "../chat/PermissionCard"
import { usePermissions } from "../chat/permissions"
import { QueuedTurns } from "../chat/QueuedTurns"
import { UsagePanel } from "../chat/UsagePanel"
import { useSessions } from "../chat/sessions"
import { Transcript } from "../chat/Transcript"
import { useChatSession } from "../chat/useChatSession"
import { ErrorBanner } from "../components/ErrorBanner"
import { ChevronDownIcon, MoreIcon } from "../components/icons"
import type { MessageKey } from "../i18n"
import { useT } from "../i18n/provider"
import { useMediaQuery } from "../lib/useMediaQuery"
import { FirstRunGate } from "../onboarding/FirstRunGate"
import { useReportPaletteChat } from "../palette/current-chat"

interface ChatLocationState {
  pendingPrompt?: unknown
}

/** Matches Tailwind's `sm`; at and above it the header fits on one row. */
const WIDE_QUERY = "(min-width: 640px)"

/**
 * Narrow-width home for the header's secondary controls (spec 04, spec 09).
 * The title and the session menu stay in the bar; the meter, usage panel and
 * completion pickers move behind this trigger so nothing is dropped at 320 px.
 * It is a labelled group, not a `menu`: its children are pickers and panels,
 * not `menuitem`s. `Escape` restores focus and an outside click closes it.
 */
function ChatHeaderActions({ children }: { children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelID = useId()

  useEffect(() => {
    if (!open) return
    // Move focus into the panel so keyboard and screen-reader users land in
    // the revealed controls instead of staying on the trigger.
    panelRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div className="relative shrink-0" data-testid="chat-header-actions">
      <button
        type="button"
        ref={triggerRef}
        data-testid="chat-header-more"
        aria-expanded={open}
        aria-controls={panelID}
        aria-label={t("menu.trigger")}
        title={t("menu.trigger")}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-ghost btn-sm btn-square"
      >
        <MoreIcon className="size-4" />
      </button>
      {open ? (
        <div
          id={panelID}
          ref={panelRef}
          role="group"
          aria-label={t("menu.label")}
          tabIndex={-1}
          data-testid="chat-header-actions-panel"
          className="absolute end-0 top-full z-50 mt-1 flex w-max max-w-[calc(100vw_-_2rem)] flex-col gap-2 overflow-x-auto rounded-row border border-subtle bg-elevated p-2 shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function ChatPage() {
  const t = useT()
  const wide = useMediaQuery(WIDE_QUERY)
  const { sessionId = "", messageId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { sessions, refresh: refreshSessions } = useSessions()
  const chat = useChatSession(sessionId)
  const permission = usePermissions(sessionId)
  const consumedFor = useRef<string | null>(null)
  const [filesVersion, setFilesVersion] = useState(0)
  const refreshFiles = useCallback(() => setFilesVersion((value) => value + 1), [])
  const [editing, setEditing] = useState<{ messageID: string; text: string } | null>(null)
  const [branchError, setBranchError] = useState(false)

  const session = sessions.find((entry) => entry.id === sessionId)
  const title = session?.title || t("session.untitled")
  const parent = session?.parentID
    ? sessions.find((entry) => entry.id === session.parentID)
    : undefined
  // A fork is not a subagent chat: it links back through `branchOf`, never
  // through `parentID`, so the two back links cannot be confused.
  const branchParent = session?.branchOf
    ? sessions.find((entry) => entry.id === session.branchOf)
    : undefined

  /** Branches other chats made before each message of this session. */
  const branchCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of sessions) {
      if (entry.branchOf !== sessionId || !entry.branchBefore) continue
      counts.set(entry.branchBefore, (counts.get(entry.branchBefore) ?? 0) + 1)
    }
    return counts
  }, [sessions, sessionId])

  // Switching chats ends an edit; the composer loads the next draft itself.
  useEffect(() => {
    setEditing(null)
    setBranchError(false)
  }, [sessionId])

  // The palette's copy action needs the newest answer without owning the
  // transcript. Reporting a plain-text value keeps raw parts inside the route.
  const lastAnswer = useMemo(() => {
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const message = chat.messages[index]
      if (message?.role !== "assistant") continue
      const text = messageText(message).trim()
      return text.length > 0 ? text : null
    }
    return null
  }, [chat.messages])

  useReportPaletteChat({ sessionID: sessionId, title, lastAnswer })

  const usage = chat.usage ?? session?.usage ?? null

  const pendingPrompt = (location.state as ChatLocationState | null)?.pendingPrompt

  useEffect(() => {
    if (consumedFor.current === sessionId) return
    if (typeof pendingPrompt !== "string" || pendingPrompt.trim().length === 0) return
    if (!chat.ready) return

    consumedFor.current = sessionId
    navigate(location.pathname, { replace: true, state: null })
    void chat
      .send(pendingPrompt)
      .then(refreshFiles)
      .catch(() => undefined)
  }, [pendingPrompt, sessionId, chat, navigate, location.pathname, refreshFiles])

  /** Forks before one message and returns the new session, or null on error. */
  const openBranch = useCallback(
    async (messageID: string) => {
      setBranchError(false)
      try {
        const forked = await api.forkSession(sessionId, messageID)
        // The sidebar and this page read branch metadata from the session
        // list, so the fork only renders as a branch after the refresh.
        await refreshSessions()
        return forked
      } catch {
        setBranchError(true)
        return null
      }
    },
    [sessionId, refreshSessions],
  )

  const branchMessage = useCallback(
    (message: Message) => {
      void openBranch(message.id).then((forked) => {
        if (forked) navigate(`/c/${forked.id}`)
      })
    },
    [openBranch, navigate],
  )

  const editMessage = useCallback((message: Message) => {
    const text = messageText(message)
    if (!text.trim()) return
    setBranchError(false)
    setEditing({ messageID: message.id, text })
  }, [])

  // Sending while editing forks first: the new branch keeps the history before
  // that message and receives the edited text as its next turn.
  const submit = useCallback(
    async (text: string) => {
      if (!editing) {
        await chat.send(text)
        return
      }
      const forked = await openBranch(editing.messageID)
      if (!forked) throw new Error("fork failed")
      setEditing(null)
      // The prefill lived in the old chat's draft key; it must not linger.
      clearDraft(sessionId)
      navigate(`/c/${forked.id}`, {
        state: { pendingPrompt: text } satisfies ChatLocationState,
      })
    },
    [editing, chat.send, openBranch, sessionId, navigate],
  )

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
        : chat.error === "cancel"
          ? t("chat.cancelFailed")
          : chat.error === "compact"
            ? t("chat.compactFailed")
            : branchError
              ? t("chat.branchFailed")
              : null

  // Editing or branching forks the host session; an active run is not a safe
  // boundary, so the actions stay hidden until it ends.
  const canBranch = !chat.running && !chat.loading

  // The same controls stay inline on desktop and move behind the overflow
  // trigger on narrow screens; rendering them once keeps their state shared.
  const secondaryControls = (
    <>
      <ContextMeter usage={chat.usage} />
      <UsagePanel report={usage} />
      <CompletionPickers />
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-subtle bg-app px-4">
        <div className="min-w-0 flex-1">
          {branchParent ? (
            <Link
              to={`/c/${branchParent.id}`}
              data-testid="branch-parent-link"
              className="flex min-w-0 items-center gap-1 text-xs text-muted hover:text-base-content"
            >
              <ChevronDownIcon className="size-3 shrink-0 rotate-90" />
              <span className="truncate">
                {t("session.branchOf", {
                  title: branchParent.title || t("session.untitled"),
                })}
              </span>
            </Link>
          ) : parent ? (
            <Link
              to={`/c/${parent.id}`}
              data-testid="parent-link"
              className="flex min-w-0 items-center gap-1 text-xs text-muted hover:text-base-content"
            >
              <ChevronDownIcon className="size-3 shrink-0 rotate-90" />
              <span className="truncate">
                {t("session.backToParent", {
                  title: parent.title || t("session.untitled"),
                })}
              </span>
            </Link>
          ) : null}
          <h1 className="truncate text-lg font-semibold">{title}</h1>
        </div>
        {wide ? secondaryControls : <ChatHeaderActions>{secondaryControls}</ChatHeaderActions>}
        <ChatMenu
          title={title}
          created={session?.created}
          messages={chat.messages}
          onCompact={() => void chat.compactNow()}
          compactDisabled={chat.running || chat.streaming}
        />
      </header>

      <ChatFiles sessionID={sessionId} version={filesVersion} />

      <Transcript
        messages={chat.messages}
        loading={chat.loading}
        failed={chat.error === "load"}
        onRetry={() => void chat.reload()}
        compactions={chat.compactions}
        onRetryCompaction={(id) => void chat.retryCompaction(id)}
        compactionDisabled={chat.running || chat.streaming}
        highlightMessageID={messageId}
        onContinue={canRecover ? () => void chat.continueRun() : undefined}
        onRetryLast={
          canRecover && chat.canRetry && chat.lastAssistantStatus === "error"
            ? () => void chat.retryLast()
            : undefined
        }
        onEditMessage={canBranch ? editMessage : undefined}
        onBranchMessage={canBranch ? branchMessage : undefined}
        branchCounts={branchCounts}
      />

      <div className="shrink-0 border-t border-subtle bg-app px-4 pb-3 pt-3">
        <div className="mx-auto w-full max-w-[768px]">
          <QueuedTurns
            entries={chat.inbox}
            onCancel={(messageID) => void chat.cancelQueued(messageID)}
          />
          <ConnectionNotice />
          {bannerMessage ? (
            <ErrorBanner
              message={bannerMessage}
              onDismiss={() => {
                chat.clearError()
                setBranchError(false)
              }}
            />
          ) : null}
          <PermissionCard value={permission} />

          <FirstRunGate>
            <Composer
              onSend={submit}
              onStop={() => void chat.stop()}
              running={chat.running}
              disabled={permission.pending}
              draftKey={sessionId}
              sessionID={sessionId}
              onAttachmentsChanged={refreshFiles}
              edit={editing}
              onCancelEdit={() => setEditing(null)}
            />
          </FirstRunGate>

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
