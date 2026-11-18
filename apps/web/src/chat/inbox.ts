import type { EventEnvelope, InboxEntry, InboxEntryKind } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"

/**
 * Pure inbox reducer. The transcript fold in `state/fold.ts` never sees inbox
 * events: a pending turn is not part of the conversation yet, so it lives in
 * its own list until the host delivers or the user cancels it.
 */

const KINDS: readonly InboxEntryKind[] = ["user", "synthetic", "compaction", "move"]

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}

function readKind(value: unknown): InboxEntryKind | null {
  return typeof value === "string" && KINDS.includes(value as InboxEntryKind)
    ? (value as InboxEntryKind)
    : null
}

function readDelivery(value: unknown): InboxEntry["delivery"] | null {
  return value === "steer" || value === "queue" ? value : null
}

/** Builds the entry for one `session.inbox.enqueued` event, or `null`. */
export function readInboxEntry(event: EventEnvelope): InboxEntry | null {
  const id = readString(event.data, "messageID")
  const sessionID = readString(event.data, "sessionID")
  const kind = readKind(event.data.kind)
  const delivery = readDelivery(event.data.delivery)
  if (!id || !sessionID || !kind || !delivery) return null
  const created = event.data.created
  return {
    id,
    sessionID,
    kind,
    text: readString(event.data, "text") ?? "",
    delivery,
    created: typeof created === "number" && Number.isFinite(created) ? created : event.created,
  }
}

export function applyInboxEvent(current: InboxEntry[], event: EventEnvelope): InboxEntry[] {
  switch (event.type) {
    case EVENT.inboxEnqueued: {
      const entry = readInboxEntry(event)
      if (!entry) return current
      // An entry is unique by message id; a duplicate re-announcement replaces
      // the old marker instead of stacking a second one.
      return [...current.filter((existing) => existing.id !== entry.id), entry]
    }

    case EVENT.inboxDelivered:
    case EVENT.inboxCancelled: {
      const id = readString(event.data, "messageID")
      if (!id) return current
      const next = current.filter((entry) => entry.id !== id)
      return next.length === current.length ? current : next
    }

    case EVENT.inboxDeliveryChanged: {
      const id = readString(event.data, "messageID")
      const delivery = readDelivery(event.data.delivery)
      if (!id || !delivery) return current
      return current.map((entry) =>
        entry.id === id && entry.delivery !== delivery ? { ...entry, delivery } : entry,
      )
    }

    default:
      return current
  }
}
