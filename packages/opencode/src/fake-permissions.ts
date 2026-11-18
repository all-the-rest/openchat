import { EVENT } from "@openchat/contracts"
import type { PermissionDecision, PermissionRequest } from "@openchat/contracts"
import { BackendError } from "./errors"

type Emit = (
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  durable: boolean,
) => unknown

/**
 * Outstanding approvals of the fake host. The only writer is `ask`, which the
 * fake-mode E2E control route calls; a reply removes the request and emits the
 * same `permission.replied` envelope the live adapter produces.
 */
export class FakePermissions {
  private readonly bySession = new Map<string, Map<string, PermissionRequest>>()
  private count = 0

  constructor(private readonly emit: Emit) {}

  list(sessionID: string): PermissionRequest[] {
    return [...(this.bySession.get(sessionID)?.values() ?? [])].map((request) => ({
      ...request,
      resources: [...request.resources],
    }))
  }

  ask(
    sessionID: string,
    tool: string,
    action: string,
    resources: readonly string[] = [],
  ): PermissionRequest {
    const request: PermissionRequest = {
      id: `per_${this.count + 1}`,
      sessionID,
      tool,
      action,
      resources: [...resources],
    }
    this.count += 1
    const requests = this.bySession.get(sessionID) ?? new Map<string, PermissionRequest>()
    requests.set(request.id, request)
    this.bySession.set(sessionID, requests)
    this.emit(
      EVENT.permissionAsked,
      sessionID,
      { sessionID, id: request.id, tool, action, resources: request.resources },
      true,
    )
    return { ...request, resources: [...request.resources] }
  }

  reply(sessionID: string, requestID: string, decision: PermissionDecision): void {
    const requests = this.bySession.get(sessionID)
    const request = requests?.get(requestID)
    if (!request || !requests) {
      throw new BackendError("not_found", `Unknown permission request: ${requestID}`)
    }
    requests.delete(requestID)
    if (requests.size === 0) this.bySession.delete(sessionID)
    this.emit(EVENT.permissionReplied, sessionID, { sessionID, requestID, decision }, true)
  }
}
