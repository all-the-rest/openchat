import { useEffect, useRef, useState } from "react"
import { useEventStream } from "../api/events"
import { AlertIcon, CheckIcon } from "../components/icons"
import { useT } from "../i18n/provider"

/** How long the "reconnected" confirmation stays visible (spec 10 M). */
export const RECONNECTED_VISIBLE_MS = 5_000

type Notice = "lost" | "reconnected" | null

/**
 * Connection recovery notice (spec 10 M). Lives in the chat surface next to the
 * error banner: an outage is announced assertively, the recovery politely, and
 * both can be dismissed without disturbing the composer.
 */
export function ConnectionNotice({
  reconnectedMs = RECONNECTED_VISIBLE_MS,
}: {
  reconnectedMs?: number
} = {}) {
  const t = useT()
  const { connection, reconnect } = useEventStream()
  const [reconnected, setReconnected] = useState(false)
  const [dismissed, setDismissed] = useState<Notice>(null)
  const seenReconnect = useRef(reconnect)

  useEffect(() => {
    if (reconnect === seenReconnect.current) return
    seenReconnect.current = reconnect
    setReconnected(true)
    setDismissed(null)
    const timer = window.setTimeout(() => setReconnected(false), reconnectedMs)
    return () => window.clearTimeout(timer)
  }, [reconnect, reconnectedMs])

  useEffect(() => {
    // A fresh outage starts a fresh notice, even after the user dismissed one.
    if (connection === "closed") setDismissed(null)
  }, [connection])

  const lost = connection === "closed"
  const notice: Notice = lost ? "lost" : reconnected ? "reconnected" : null
  if (notice === null || dismissed === notice) return null

  const dismiss = () => setDismissed(notice)

  if (notice === "lost") {
    return (
      <div
        role="alert"
        data-testid="connection-lost"
        className="mb-2 flex w-full items-center gap-3 rounded-card border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
      >
        <AlertIcon className="size-4 shrink-0" />
        <p className="flex-1">{t("chat.connectionLost")}</p>
        <button type="button" onClick={dismiss} className="btn btn-ghost btn-xs text-warning">
          {t("chat.dismiss")}
        </button>
      </div>
    )
  }

  return (
    <div
      role="status"
      data-testid="connection-reconnected"
      className="mb-2 flex w-full items-center gap-3 rounded-card border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
    >
      <CheckIcon className="size-4 shrink-0" />
      <p className="flex-1">{t("chat.reconnected")}</p>
      <button type="button" onClick={dismiss} className="btn btn-ghost btn-xs text-success">
        {t("chat.dismiss")}
      </button>
    </div>
  )
}
