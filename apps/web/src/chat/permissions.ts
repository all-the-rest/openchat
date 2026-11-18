import type { PermissionDecision, PermissionRequest } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api/client"
import { useEventStreamOrNull } from "../api/events"

export interface PermissionValue {
  requests: PermissionRequest[]
  pending: boolean
  busy: boolean
  failure: boolean
  reply: (requestID: string, decision: PermissionDecision) => Promise<boolean>
}

/**
 * Outstanding approvals of one session. The initial list survives a reload;
 * the event stream adds asks and removes them on a reply. A failed reply keeps
 * the card so the user can try a different decision.
 */
export function usePermissions(sessionID: string): PermissionValue {
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const stream = useEventStreamOrNull()

  useEffect(() => {
    let active = true
    setRequests([])
    setFailure(false)
    void api.listPermissions(sessionID)
      .then((list) => {
        if (active) setRequests(list)
      })
      .catch(() => {
        if (active) setRequests([])
      })
    return () => {
      active = false
    }
  }, [sessionID])

  useEffect(() => {
    if (!stream) return
    return stream.subscribe((event) => {
      const data = event.data
      if (typeof data.sessionID === "string" && data.sessionID !== sessionID) return
      if (event.type === EVENT.permissionAsked) {
        const id = typeof data.id === "string" ? data.id : ""
        const tool = typeof data.tool === "string" ? data.tool : ""
        const action = typeof data.action === "string" ? data.action : ""
        if (!id || !tool || !action) return
        const resources = Array.isArray(data.resources)
          ? data.resources.filter((item): item is string => typeof item === "string")
          : []
        setRequests((current) =>
          current.some((request) => request.id === id)
            ? current
            : [...current, { id, sessionID, tool, action, resources }],
        )
      }
      if (event.type === EVENT.permissionReplied) {
        const requestID = typeof data.requestID === "string" ? data.requestID : ""
        if (requestID) setRequests((current) => current.filter((entry) => entry.id !== requestID))
      }
    })
  }, [stream, sessionID])

  const reply = useCallback(
    async (requestID: string, decision: PermissionDecision) => {
      setBusy(true)
      setFailure(false)
      try {
        await api.replyPermission(sessionID, requestID, decision)
        // The `permission.replied` event confirms it; removing here too keeps
        // the card from lingering when the stream is momentarily down.
        setRequests((current) => current.filter((entry) => entry.id !== requestID))
        return true
      } catch {
        setFailure(true)
        return false
      } finally {
        setBusy(false)
      }
    },
    [sessionID],
  )

  return { requests, pending: requests.length > 0, busy, failure, reply }
}
