import type { AppServer, AppSkill } from "@openchat/contracts"
import type { McpServer, OpenCodeClient, SkillInfo } from "@opencode/client"
import { BackendError } from "./errors"
import type { AppsSnapshot } from "./index"

/**
 * An upstream MCP error can be a stack trace or a provider payload. The list
 * shows one line, so the adapter keeps a bounded, printable excerpt and drops
 * the rest; the full text stays upstream.
 */
const MAX_ERROR_LENGTH = 300
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g
const WHITESPACE = /\s+/g

function errorExcerpt(raw: string): string | undefined {
  const clean = raw.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim()
  if (clean.length === 0) return undefined
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}…` : clean
}

function normalizeServer(server: McpServer): AppServer {
  const status = server.status.status
  const normalized: AppServer = { name: server.name, status }
  const title = server.title?.trim()
  if (title) normalized.title = title
  if (server.integrationID) normalized.integrationID = server.integrationID
  // `error` is part of exactly two states; the other three carry none, so a
  // stale error can never look like a fifth state.
  if (server.status.status === "failed" || server.status.status === "needs_auth") {
    const error = errorExcerpt(server.status.error)
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
  return {
    servers: servers.status === "fulfilled" ? servers.value.data.map(normalizeServer) : [],
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
