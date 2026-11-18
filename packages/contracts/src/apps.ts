/**
 * App surface: MCP servers and skills of the workspace, plus the availability
 * flag `/api/info` carries so the client can hide the entry. Tools are not
 * part of the surface: the pinned `@opencode/client` cannot list or run them.
 */

/**
 * Connection states of an MCP server, mirroring the pinned client's
 * `McpServer.status.status`. `needs_auth` is the client's spelling; the UI
 * localises it.
 */
export const APP_STATUSES = [
  "connected",
  "pending",
  "disabled",
  "failed",
  "needs_auth",
] as const
export type AppStatus = (typeof APP_STATUSES)[number]

/** One MCP server of the workspace, as `/api/apps` reports it. */
export interface AppServer {
  /** Host-side name; the identifier `connect`/`disconnect` take. */
  name: string
  title?: string
  status: AppStatus
  /** Only for `failed` and `needs_auth`; already truncated by the adapter. */
  error?: string
  integrationID?: string
}

/**
 * One skill of the workspace. The host also returns `path` and `content`;
 * both stay upstream because they are workspace-local and can be large.
 */
export interface AppSkill {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
}

/** Result of `GET /api/apps`. */
export interface AppsResponse {
  /**
   * True when the host answered the capability probe. Independent of the
   * number of servers: an empty deployment is available with no rows.
   */
  available: boolean
  servers: AppServer[]
  skills: AppSkill[]
}

/**
 * App surface availability, delivered with `/api/info` so the client can hide
 * the `/apps` navigation entry without a second request.
 */
export interface AppsSurfaceInfo {
  /** False when the host cannot answer; the UI must hide the entry. */
  available: boolean
}
