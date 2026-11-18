import type { Message, MessageStatus } from "@openchat/contracts"
import { EVENT, messageText } from "@openchat/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"
import { useEventStream } from "../api/events"
import { useSurfaceOrNull } from "../code/SurfaceProvider"
import { createID } from "../lib/ids"
import { applyEvent, isTerminalEvent } from "../state/fold"

export type ChatError = "load" | "send" | "stop" | null

export interface ChatSessionValue {
  messages: Message[]
  loading: boolean
  error: ChatError
  submitting: boolean
  streaming: boolean
  stopped: boolean
  running: boolean
  /** A prompt was accepted into the queue of the active run (spec 10 B). */
  queued: boolean
  lastAssistantStatus: MessageStatus | null
  canRetry: boolean
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  reload: (options?: { silent?: boolean }) => Promise<void>
  /** Asks the assistant to continue a stopped or completed answer. */
  continueRun: () => Promise<void>
  /** Re-sends the text of the most recent user message. */
  retryLast: () => Promise<void>
  clearError: () => void
}

export function useChatSession(sessionID: string): ChatSessionValue {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ChatError>(null)
  const [submitting, setSubmitting] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [queued, setQueued] = useState(false)
  const { subscribe, reconnect } = useEventStream()
  const hostReachable = useSurfaceOrNull()?.hostReachable ?? null

  const activeSession = useRef(sessionID)
  activeSession.current = sessionID

  const inFlight = useRef<string | null>(null)

  const reload = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const target = sessionID
      // Overlapping reloads for the same session would race each other; a
      // reconnect that lands during the initial load is covered by it.
      if (inFlight.current === target) return

      inFlight.current = target
      if (!options.silent) setLoading(true)
      try {
        const list = await api.listMessages(target)
        if (activeSession.current !== target) return
        setMessages(list)
        setQueued(false)
        setError(null)
      } catch {
        if (activeSession.current !== target) return
        if (!options.silent) setError("load")
      } finally {
        if (inFlight.current === target) inFlight.current = null
        if (activeSession.current === target) setLoading(false)
      }
    },
    [sessionID],
  )

  useEffect(() => {
    setMessages([])
    setSubmitting(false)
    setStopped(false)
    setQueued(false)
    setError(null)
    void reload()
  }, [reload])

  // Reconnect means events may have been missed while the stream was down.
  // Reload the authoritative snapshot without blanking the transcript.
  const reconnectSeen = useRef(reconnect)
  useEffect(() => {
    if (reconnect === reconnectSeen.current) return
    reconnectSeen.current = reconnect
    void reload({ silent: true })
  }, [reconnect, reload])

  // A host that comes back is the same signal as a stream reconnect: re-read
  // the transcript silently, so an outage that failed the first load heals
  // without a page reload and without dropping what is already on screen.
  const previousReachable = useRef(hostReachable)
  useEffect(() => {
    const previous = previousReachable.current
    previousReachable.current = hostReachable
    if (previous === false && hostReachable === true) void reload({ silent: true })
  }, [hostReachable, reload])

  useEffect(() => {
    return subscribe((event) => {
      const eventSession = event.data.sessionID
      if (typeof eventSession === "string" && eventSession !== activeSession.current) return
      setMessages((current) => applyEvent(current, event))
      if (event.type === EVENT.executionStarted) {
        setStopped(false)
        setQueued(false)
      }
      if (event.type === EVENT.interrupted) setStopped(true)
      if (isTerminalEvent(event.type)) setSubmitting(false)
    })
  }, [subscribe])

  const runningRef = useRef(false)

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const queue = runningRef.current
      const localID = createID("msg")
      const optimistic: Message = {
        id: localID,
        sessionID,
        role: "user",
        parts: [{ type: "text", id: createID("part"), text: trimmed }],
        created: Date.now(),
        status: "complete",
      }

      setMessages((current) => [...current, optimistic])
      if (queue) setQueued(true)
      else setSubmitting(true)
      setStopped(false)
      setError(null)

      try {
        // The response confirms the run, not the user message ID: the fake and
        // live backends return the assistant message ID here.
        const result = await api.prompt(
          sessionID,
          queue ? { text: trimmed, delivery: "queue" } : { text: trimmed },
        )
        if (result?.queued) setQueued(true)
      } catch (failure) {
        // Keep the draft in the composer by throwing; drop the optimistic echo.
        setMessages((current) => current.filter((message) => message.id !== localID))
        setSubmitting(false)
        setQueued(false)
        setError("send")
        throw failure
      }
    },
    [sessionID],
  )

  const stop = useCallback(async () => {
    setError(null)
    try {
      await api.interrupt(sessionID)
      // Optimistic: the interrupted event confirms it, but the button should
      // disappear as soon as the request succeeded.
      setSubmitting(false)
      setStopped(true)
      setMessages((current) =>
        current.map((message) =>
          message.status === "streaming" ? { ...message, status: "stopped" } : message,
        ),
      )
    } catch {
      setError("stop")
    }
  }, [sessionID])

  const continueRun = useCallback(async () => {
    await send("continue")
  }, [send])

  const retryLast = useCallback(async () => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== "user") continue
      const text = messageText(message)
      if (text.trim().length === 0) return
      await send(text)
      return
    }
  }, [messages, send])

  const clearError = useCallback(() => setError(null), [])

  const streaming = messages.some((message) => message.status === "streaming")

  let lastAssistantStatus: MessageStatus | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant") {
      lastAssistantStatus = message.status
      break
    }
  }

  const running = submitting || streaming
  runningRef.current = running
  const canRetry = messages.some((message) => message.role === "user")

  return {
    messages,
    loading,
    error,
    submitting,
    streaming,
    stopped,
    running,
    queued,
    lastAssistantStatus,
    canRetry,
    send,
    stop,
    reload,
    continueRun,
    retryLast,
    clearError,
  }
}
