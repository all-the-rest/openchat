import { z } from "zod"

/**
 * One outstanding tool approval. `tool` is the host's action name (in practice
 * the tool asking), `action` is the human-readable description of the request.
 */
export interface PermissionRequest {
  id: string
  sessionID: string
  tool: string
  action: string
  resources: string[]
}

/** The UI decision; the live adapter maps `deny` to the host's `reject`. */
export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionsResponse {
  requests: PermissionRequest[]
}

/** The three decisions the permission card can send to the BFF. */
export const permissionReplyRequestSchema = z.object({
  decision: z.enum(["once", "always", "deny"]),
})
