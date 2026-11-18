import type { CompactionNotice, EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}

function readReason(value: unknown): CompactionNotice["reason"] {
  return value === "auto" ? "auto" : "manual"
}

function readFailure(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined
  const message = (value as Record<string, unknown>).message
  return typeof message === "string" ? message : undefined
}

/** Last started notice of the same session and reason, so ended finds its pair. */
function lastOpenIndex(
  current: CompactionNotice[],
  sessionID: string,
  reason: CompactionNotice["reason"],
): number {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const notice = current[index]
    if (!notice) continue
    if (notice.sessionID !== sessionID) continue
    if (notice.reason !== reason) continue
    if (notice.status !== "started") continue
    return index
  }
  return -1
}

/**
 * Fold one compaction event into the transcript notices. Pure, so the
 * started/ended/failed pairing is testable without the event stream.
 */
export function applyCompactionEvent(
  current: CompactionNotice[],
  event: EventEnvelope,
): CompactionNotice[] {
  const sessionID = readString(event.data, "sessionID")
  if (!sessionID) return current
  const reason = readReason(event.data.reason)

  if (event.type === EVENT.compactionStarted) {
    const notice: CompactionNotice = {
      id: event.id,
      sessionID,
      reason,
      status: "started",
      created: event.created,
    }
    return [...current, notice]
  }

  if (event.type === EVENT.compactionEnded) {
    const summary = readString(event.data, "text")
    const index = lastOpenIndex(current, sessionID, reason)
    if (index === -1) {
      const notice: CompactionNotice = {
        id: event.id,
        sessionID,
        reason,
        status: "ended",
        created: event.created,
      }
      if (summary) notice.summary = summary
      return [...current, notice]
    }
    return current.map((notice, position) => {
      if (position !== index) return notice
      const next: CompactionNotice = { ...notice, status: "ended" }
      if (summary) next.summary = summary
      return next
    })
  }

  if (event.type === EVENT.compactionFailed) {
    const error = readFailure(event.data.error)
    const index = lastOpenIndex(current, sessionID, reason)
    const terminal = (notice: CompactionNotice): CompactionNotice => {
      const next: CompactionNotice = { ...notice, status: "failed" }
      if (error) next.error = error
      return next
    }
    if (index === -1) {
      const notice: CompactionNotice = {
        id: event.id,
        sessionID,
        reason,
        status: "failed",
        created: event.created,
      }
      if (error) notice.error = error
      return [...current, notice]
    }
    return current.map((notice, position) => (position === index ? terminal(notice) : notice))
  }

  return current
}

/** Drops one notice so a retry starts from a clean section. */
export function dropCompaction(
  current: CompactionNotice[],
  id: string,
): CompactionNotice[] {
  const next = current.filter((notice) => notice.id !== id)
  return next.length === current.length ? current : next
}
