import type { Message, SessionInfo } from "@openchat/contracts"
import type { SessionState } from "./fake-state"

/** Fixed ids so an E2E test can address the pair without depending on order. */
export const FAKE_SUBAGENT_PARENT_ID = "ses_subagent_parent"
export const FAKE_SUBAGENT_CHILD_ID = "ses_subagent_child"
export const FAKE_SUBAGENT_PARENT_TITLE = "Quarterly report review"
export const FAKE_SUBAGENT_CHILD_TITLE = "Agent: check the figures"

function message(
  id: string,
  sessionID: string,
  role: Message["role"],
  text: string,
  created: number,
): Message {
  return {
    id,
    sessionID,
    role,
    parts: [{ type: "text", id: `${id}_text`, text }],
    created,
    status: "complete",
  }
}

/**
 * One parent chat and one child session linked by `parentID`, for the nested
 * sidebar, the back link and the E2E suite. Both sides carry a finished turn,
 * so opening either session renders a transcript instead of an empty shell.
 */
export function subagentSeedSessions(workspace: string, created: number): SessionState[] {
  const parent: SessionInfo = {
    id: FAKE_SUBAGENT_PARENT_ID,
    title: FAKE_SUBAGENT_PARENT_TITLE,
    directory: workspace,
    created,
    updated: created + 2,
  }
  const child: SessionInfo = {
    id: FAKE_SUBAGENT_CHILD_ID,
    title: FAKE_SUBAGENT_CHILD_TITLE,
    directory: workspace,
    created: created + 1,
    updated: created + 3,
    parentID: parent.id,
  }

  return [
    {
      info: parent,
      messages: [
        message(
          "msg_subagent_parent_user",
          parent.id,
          "user",
          "Can you review the quarterly figures?",
          created,
        ),
        message(
          "msg_subagent_parent_assistant",
          parent.id,
          "assistant",
          "I will check the totals and hand the arithmetic to a subagent.",
          created + 1,
        ),
      ],
    },
    {
      info: child,
      messages: [
        message(
          "msg_subagent_child_user",
          child.id,
          "user",
          "Verify the revenue totals.",
          created + 1,
        ),
        message(
          "msg_subagent_child_assistant",
          child.id,
          "assistant",
          "Revenue matches the reported total.",
          created + 2,
        ),
      ],
    },
  ]
}
