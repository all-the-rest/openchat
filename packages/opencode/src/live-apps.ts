import { APP_STATUSES } from "@openchat/contracts"
import type { AppServer, AppSkill, AppStatus } from "@openchat/contracts"
import type { McpServer, OpenCodeClient, SkillInfo } from "@opencode/client"
import { BackendError } from "./errors"
import type { AppsSnapshot } from "./index"

/**
 * An upstream MCP error can be a stack trace or a provider payload. The list
 * shows one line, so the adapter keeps a bounded, printable excerpt and drops
 * the rest; the full text stays upstream. The ellipsis is appended after the
 * bound, so a stored error is at most 301 characters.
 */
const MAX_ERROR_LENGTH = 300
/**
 * C0 and C1 controls, DEL, zero-width marks, line/paragraph separators, bidi
 * overrides and the BOM: all of them can rewrite how a row reads.
 */
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g
const WHITESPACE = /\s+/g

function errorExcerpt(raw: string): string | undefined {
  const clean = raw.replace(UNSAFE_CHARACTERS, " ").replace(WHITESPACE, " ").trim()
  if (clean.length === 0) return undefined
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}…` : clean
}

function isAppStatus(value: unknown): value is AppStatus {
  return typeof value === "string" && (APP_STATUSES as readonly string[]).includes(value)
}

/** Host JSON is untrusted: every field is checked before it becomes a row. */
interface RawServer {
  name?: unknown
  title?: unknown
  integrationID?: unknown
  status?: { status?: unknown; error?: unknown }
}

/**
 * One host row, or `undefined` when it cannot be a list entry. A row without a
 * usable name or with an unknown status is skipped: one malformed server must
 * not turn the whole list into a 502.
 */
function normalizeServer(server: McpServer): AppServer | undefined {
  const raw = server as unknown as RawServer
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  const status = raw.status?.status
  if (name.length === 0 || !isAppStatus(status)) return undefined
  const normalized: AppServer = { name, status }
  const title = typeof raw.title === "string" ? raw.title.trim() : ""
  if (title) normalized.title = title
  if (typeof raw.integrationID === "string" && raw.integrationID) {
    normalized.integrationID = raw.integrationID
  }
  // `error` is part of exactly two states; the other three carry none, so a
  // stale error can never look like a fifth state.
  if (status === "failed" || status === "needs_auth") {
    const error =
      typeof raw.status?.error === "string" ? errorExcerpt(raw.status.error) : undefined
    if (error) normalized.error = error
  }
  return normalized
}

/** `path` and `content` stay upstream: workspace-local and potentially large. */
function normalizeSkill(skill: SkillInfo): AppSkill {
  const normalized: AppSkill = { id: skill.id, name: skill.name }
  const description = skill.description?.trim()
  if (description) normalized.description = description
  if (skill.autoinvoke !== undefined) normalized.autoinvoke = skill.autoinvoke
  return normalized
}

/**
 * Reads both lists in one round. They are independent surfaces on the host, so
 * one failing list must not hide the other; only when both fail is the
 * capability unanswerable.
 */
export async function liveApps(
  client: OpenCodeClient,
  workspace: string,
): Promise<AppsSnapshot> {
  const [servers, skills] = await Promise.allSettled([
    client.mcp.list({ location: { directory: workspace } }),
    client.skill.list({ location: { directory: workspace } }),
  ])
  if (servers.status === "rejected" && skills.status === "rejected") {
    throw new BackendError("unavailable", "The host did not answer the apps capability")
  }
  const serverRows = servers.status === "fulfilled" ? servers.value.data : []
  return {
    servers: serverRows
      .map(normalizeServer)
      .filter((server): server is AppServer => server !== undefined),
    skills: skills.status === "fulfilled" ? skills.value.data.map(normalizeSkill) : [],
  }
}

export type AppAction = "connect" | "disconnect"

/** Rejects an empty name before it can reach the host. */
export function requireAppName(name: string): string {
  const server = name.trim()
  if (server.length === 0) throw new BackendError("invalid", "An app name is required")
  return server
}

/** One connect/disconnect call; a rejection never carries upstream text on. */
export async function liveAppAction(
  client: OpenCodeClient,
  workspace: string,
  action: AppAction,
  name: string,
): Promise<void> {
  const server = requireAppName(name)
  const location = { location: { directory: workspace } }
  try {
    if (action === "connect") {
      await client.experimental.mcp.connect({ server, ...location })
    } else {
      await client.experimental.mcp.disconnect({ server, ...location })
    }
  } catch {
    // The rejection may carry a URL, a token or a workspace path, so the
    // message is fixed and the cause is dropped.
    throw new BackendError("unavailable", `The host did not accept the ${action} request`)
  }
}
