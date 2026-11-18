import type {
  Message,
  SearchHit,
  SearchSource,
  SessionInfo,
} from "@openchat/contracts"
import { SEARCH_SOURCES } from "@openchat/contracts"
import type { SearchInput, SearchOutcome } from "./index"
import { defaultAppEntries } from "./fake-apps"
import type { FakeAppEntry } from "./fake-apps"

/** The slice of a session the fake search needs; `fake.ts` owns the store. */
export interface SearchableSession {
  info: SessionInfo
  messages: Message[]
}

export interface FakeSearchOptions {
  /** Sources the fake cannot query, so the route reports them as disabled. */
  disabled?: readonly SearchSource[]
  /** Sources that throw, so the route reports a partial failure. */
  failing?: readonly SearchSource[]
  /**
   * Current app rows. `fake.ts` passes its inventory so a status change is
   * visible here too; anything else gets the default inventory.
   */
  apps?: readonly FakeAppEntry[]
}

const FILES: ReadonlyArray<{ path: string; snippet: string }> = [
  { path: "README.md", snippet: "OpenChat — self-hosted chat UI over OpenCode." },
  {
    path: "docs/spec/01-product-scope.md",
    snippet: "Functional requirements and acceptance criteria for the chat UI.",
  },
  {
    path: "apps/server/src/app.ts",
    snippet: "Hono application, route registration and the health endpoint.",
  },
  {
    path: "apps/web/src/App.tsx",
    snippet: "Application shell, providers and client-side routes.",
  },
]

const WEB: ReadonlyArray<{ url: string; title: string; snippet: string }> = [
  {
    url: "https://example.test/openchat-overview",
    title: "OpenChat overview",
    snippet: "A clean-room chat interface that talks to an OpenCode host.",
  },
  {
    url: "https://example.test/opencode-client",
    title: "OpenCode client reference",
    snippet: "The typed client the BFF uses for sessions, files and search.",
  },
]

function matches(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase())
}

/** A short window around the first match; the full text stays at the source. */
function excerpt(text: string, query: string, width = 60): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return text.slice(0, width * 2).trim()
  const start = Math.max(0, index - width)
  const end = Math.min(text.length, index + query.length + width)
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function chatHits(
  sessions: readonly SearchableSession[],
  query: string,
  limit: number,
): SearchHit[] {
  const needle = query.toLowerCase()
  const hits: SearchHit[] = []
  for (const session of sessions) {
    if (hits.length >= limit) break
    const title = session.info.title.trim()
    if (title.length > 0 && matches(title, needle)) {
      hits.push({
        source: "chats",
        id: `chat-${session.info.id}`,
        title,
        sessionID: session.info.id,
      })
    }
    for (const message of session.messages) {
      if (hits.length >= limit) break
      const text = textOf(message)
      if (!matches(text, needle)) continue
      hits.push({
        source: "chats",
        id: `message-${message.id}`,
        title: title.length > 0 ? title : "Untitled chat",
        snippet: excerpt(text, query),
        sessionID: session.info.id,
        messageID: message.id,
      })
    }
  }
  return hits
}

function workspaceHits(query: string, limit: number): SearchHit[] {
  const needle = query.toLowerCase()
  return FILES.filter((file) => matches(file.path, needle) || matches(file.snippet, needle))
    .slice(0, limit)
    .map((file) => ({
      source: "workspace",
      id: `file-${file.path}`,
      title: file.path,
      snippet: file.snippet,
      path: file.path,
    }))
}

function webHits(query: string, limit: number): SearchHit[] {
  const needle = query.toLowerCase()
  return WEB.filter((entry) => matches(entry.title, needle) || matches(entry.snippet, needle))
    .slice(0, limit)
    .map((entry) => ({
      source: "web",
      id: entry.url,
      title: entry.title,
      snippet: entry.snippet,
      url: entry.url,
      provider: "fake",
    }))
}

function appHits(
  query: string,
  limit: number,
  entries: readonly FakeAppEntry[],
): SearchHit[] {
  const needle = query.toLowerCase()
  return entries
    .filter(
      (entry) =>
        matches(entry.app, needle) ||
        matches(entry.title, needle) ||
        matches(entry.snippet ?? "", needle),
    )
    .slice(0, limit)
    .map((entry) => ({
      source: "apps",
      id: `app-${entry.kind}-${entry.app}`,
      title: entry.title,
      snippet: entry.snippet,
      app: entry.app,
      appKind: entry.kind,
      status: entry.status,
    }))
}

function collect(
  source: SearchSource,
  sessions: readonly SearchableSession[],
  input: SearchInput,
  apps: readonly FakeAppEntry[],
): SearchHit[] {
  switch (source) {
    case "chats":
      return chatHits(sessions, input.query, input.limit)
    case "workspace":
      return workspaceHits(input.query, input.limit)
    case "web":
      return webHits(input.query, input.limit)
    case "apps":
      return appHits(input.query, input.limit, apps)
  }
}

/**
 * Deterministic offline search over the fake store. Availability mirrors a
 * configured deployment: every source exists unless a test disables it.
 */
export function fakeSearch(
  input: SearchInput,
  sessions: readonly SearchableSession[],
  options: FakeSearchOptions = {},
): SearchOutcome {
  const disabled = new Set(options.disabled ?? [])
  const failing = new Set(options.failing ?? [])
  const apps = options.apps ?? defaultAppEntries()
  const available = SEARCH_SOURCES.filter((source) => !disabled.has(source))
  const hits: SearchHit[] = []
  const failed: SearchSource[] = []
  for (const source of input.sources) {
    if (!available.includes(source)) continue
    if (failing.has(source)) {
      failed.push(source)
      continue
    }
    hits.push(...collect(source, sessions, input, apps))
  }
  return { available: [...available], hits, failed }
}
