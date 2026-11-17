import type { SearchHit, SearchSource } from "@openchat/contracts"
import { SEARCH_SOURCES } from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import type { SearchInput, SearchOutcome } from "./index"

/** Search hits are a summary; keep snippets short enough for a list. */
const SNIPPET_LENGTH = 200

function snippet(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length === 0) return undefined
  return clean.length > SNIPPET_LENGTH ? `${clean.slice(0, SNIPPET_LENGTH)}…` : clean
}

async function chatHits(
  client: OpenCodeClient,
  workspace: string,
  input: SearchInput,
): Promise<SearchHit[]> {
  const response = await client.session.list({
    directory: workspace,
    search: input.query,
    limit: input.limit,
  })
  return response.data.map((session) => ({
    source: "chats",
    id: `chat-${session.id}`,
    title: session.title?.trim() || "Untitled chat",
    sessionID: session.id,
  }))
}

async function workspaceHits(
  client: OpenCodeClient,
  workspace: string,
  input: SearchInput,
): Promise<SearchHit[]> {
  const response = await client.file.find({
    location: { directory: workspace },
    query: input.query,
    limit: input.limit,
  })
  return response.data.map((entry) => ({
    source: "workspace",
    id: `file-${entry.path}`,
    title: entry.path,
    path: entry.path,
  }))
}

async function webHits(
  client: OpenCodeClient,
  input: SearchInput,
): Promise<SearchHit[]> {
  const response = await client.websearch.query({ query: input.query })
  const provider = response.data.providerID
  // Dedupe before the cap: a provider that repeats a URL must not cost the
  // group a slot that another unique result could have used.
  const seen = new Set<string>()
  const results = response.data.results.filter((result) => {
    if (seen.has(result.url)) return false
    seen.add(result.url)
    return true
  })
  return results.slice(0, input.limit).map((result) => ({
    source: "web",
    id: result.url,
    title: result.title?.trim() || result.url,
    snippet: snippet(result.content),
    url: result.url,
    provider,
    published: result.time.published,
  }))
}

async function appHits(
  client: OpenCodeClient,
  workspace: string,
  input: SearchInput,
): Promise<SearchHit[]> {
  // Servers and skills are independent sources on the host; one failing list
  // must not hide the other. Both are scoped to the workspace like chats and
  // files, so a host with several workspaces answers for the right one.
  const [servers, skills] = await Promise.allSettled([
    client.mcp.list({ location: { directory: workspace } }),
    client.skill.list({ location: { directory: workspace } }),
  ])
  if (servers.status === "rejected" && skills.status === "rejected") {
    throw servers.reason
  }
  const needle = input.query.toLowerCase()
  const hits: SearchHit[] = []
  if (servers.status === "fulfilled") {
    for (const server of servers.value.data) {
      const name = server.title?.trim() || server.name
      if (!name.toLowerCase().includes(needle) && !server.name.toLowerCase().includes(needle)) {
        continue
      }
      hits.push({
        source: "apps",
        id: `app-server-${server.name}`,
        title: name,
        app: server.name,
        appKind: "server",
        status: server.status.status,
      })
    }
  }
  if (skills.status === "fulfilled") {
    for (const skill of skills.value.data) {
      if (
        !skill.name.toLowerCase().includes(needle) &&
        !(skill.description ?? "").toLowerCase().includes(needle)
      ) {
        continue
      }
      hits.push({
        source: "apps",
        id: `app-skill-${skill.id}`,
        title: skill.name,
        snippet: snippet(skill.description),
        app: skill.name,
        appKind: "skill",
        status: "available",
      })
    }
  }
  return hits.slice(0, input.limit)
}

/**
 * Proxies the Code host's own search surfaces. The BFF holds no provider keys:
 * web results come from whatever the host configured, and workspace files are
 * whatever the host sees.
 */
export async function liveSearch(
  client: OpenCodeClient,
  workspace: string,
  input: SearchInput,
): Promise<SearchOutcome> {
  const requested = new Set(input.sources)
  const available = new Set<SearchSource>(["chats", "workspace", "apps"])
  const failed: SearchSource[] = []

  // Web is configured on the host, so availability is a configuration fact.
  let webProviders = 0
  try {
    const providers = await client.websearch.providers()
    webProviders = providers.data.length
  } catch {
    // An unreachable probe cannot tell "unconfigured" from "broken". Web stays
    // in `available` so the toggle is request-independent; if it was asked for,
    // the group reports the failed attempt instead of a silent empty result.
    available.add("web")
    if (requested.has("web")) failed.push("web")
  }
  if (webProviders > 0) available.add("web")

  const hits: SearchHit[] = []
  // The route already dedupes, but a direct caller must not query twice.
  for (const source of new Set(input.sources)) {
    if (!available.has(source) || failed.includes(source)) continue
    try {
      if (source === "chats") hits.push(...(await chatHits(client, workspace, input)))
      if (source === "workspace") hits.push(...(await workspaceHits(client, workspace, input)))
      if (source === "web") hits.push(...(await webHits(client, input)))
      if (source === "apps") hits.push(...(await appHits(client, workspace, input)))
    } catch {
      failed.push(source)
    }
  }

  return {
    available: SEARCH_SOURCES.filter((source) => available.has(source)),
    hits,
    failed,
  }
}
