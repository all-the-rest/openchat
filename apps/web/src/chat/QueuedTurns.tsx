import type { InboxEntry } from "@openchat/contracts"
import { useT } from "../i18n/provider"

export interface QueuedTurnsProps {
  entries: InboxEntry[]
  onCancel(messageID: string): void
}

/**
 * The session's pending turns, restored from `/api/inbox` on load and kept in
 * sync by the `session.inbox.*` events. They are deliberately outside the
 * transcript: a queued turn becomes part of the conversation only when the
 * host delivers it.
 */
export function QueuedTurns({ entries, onCancel }: QueuedTurnsProps) {
  const t = useT()
  if (entries.length === 0) return null

  return (
    <section
      aria-label={t("chat.inboxLabel")}
      data-testid="queued-turns"
      className="mb-2 rounded-card border border-subtle bg-surface px-3 py-2"
    >
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 text-sm">
            <span className="badge badge-soft badge-xs shrink-0">
              {t("chat.statusQueued")}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted" title={entry.text || undefined}>
              {entry.text.trim().length > 0 ? entry.text : t("chat.inboxPendingStep")}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => onCancel(entry.id)}
            >
              {t("chat.inboxCancel")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
