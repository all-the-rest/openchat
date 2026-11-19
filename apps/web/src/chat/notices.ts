import type { Message, PromptNotice } from "@openchat/contracts"
import { translate, type Locale, type MessageKey } from "../i18n"
import { createID } from "../lib/ids"

const NOTICE_KEYS: Record<PromptNotice, MessageKey> = {
  contextCompacted: "chat.contextCompactedNotice",
  contextCompactionFailed: "chat.contextCompactionFailedNotice",
  // Defensive: the contract delivers fallbackUsed over SSE, not synchronously.
  // If it ever arrives in PromptResponse.notices, use the var-free sibling id;
  // the SSE path uses "chat.fallback.notice" with the target model.
  fallbackUsed: "chat.fallback.notice.plain",
}

/**
 * System entries for the notices a prompt response carried. They belong to the
 * transcript, so the owner sees why a send was preceded by a compaction or why
 * the compaction failed; the text is localized in the caller's locale.
 */
export function noticeMessages(
  notices: PromptNotice[],
  sessionID: string,
  locale: Locale,
): Message[] {
  return notices.map((notice) => ({
    id: createID("msg"),
    sessionID,
    role: "system",
    parts: [
      { type: "text", id: createID("part"), text: translate(locale, NOTICE_KEYS[notice]) },
    ],
    created: Date.now(),
    status: "complete",
  }))
}
