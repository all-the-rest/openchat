import type { OpenCodeClient } from "@opencode/client"
import type { PermissionDecision, PermissionRequest } from "@openchat/contracts"
import { BackendError } from "./errors"

type HostRequest = Awaited<ReturnType<OpenCodeClient["permission"]["list"]>>[number]
type GetInput = Parameters<OpenCodeClient["permission"]["get"]>[0]
type ReplyInput = Parameters<OpenCodeClient["permission"]["reply"]>[0]

/** The host's `action` is the tool name; `message` describes the request. */
export function normalizePermissionRequest(entry: HostRequest): PermissionRequest {
  return {
    id: entry.id,
    sessionID: entry.sessionID,
    tool: entry.action,
    action: entry.message ?? entry.resources.join(", "),
    resources: [...entry.resources],
  }
}

/**
 * `permission.reply` reports a miss generically, so a pre-read distinguishes
 * the unknown-id case the BFF maps to 404 from a transient host failure.
 */
export async function replyHostPermission(
  client: OpenCodeClient,
  sessionID: string,
  requestID: string,
  decision: PermissionDecision,
): Promise<void> {
  try {
    await client.permission.get({ sessionID, requestID } as GetInput)
  } catch {
    throw new BackendError("not_found", `Unknown permission request: ${requestID}`)
  }
  await client.permission.reply({
    sessionID,
    requestID,
    decision: decision === "deny" ? "reject" : decision,
  } as ReplyInput)
}
