import type { AppServer, AppSkill, AppStatus, SearchSource } from "@openchat/contracts"
import type { AppsSnapshot } from "./index"
import { BackendError } from "./errors"

/**
 * The fake's one app inventory. `fake.ts` serves it through the port and
 * `fake-search.ts` derives its `apps` hits from the same rows, so a status
 * change (connect/disconnect) shows up in both places and the two surfaces
 * cannot disagree. State is per instance; nothing here touches the clock.
 *
 * `summary` is search text only: the contract has no description for a server
 * and `/api/apps` must not invent one.
 */
interface FakeServerRow {
  name: string
  title: string
  summary: string
  status: AppStatus
  error?: string
}

interface FakeSkillRow {
  id: string
  name: string
  description: string
  autoinvoke?: boolean
}

/** One `apps` search hit, derived from the current inventory. */
export interface FakeAppEntry {
  app: string
  title: string
  snippet?: string
  kind: "server" | "skill"
  status: string
}

/** One row of every `AppStatus`, so all five states are reachable in tests. */
const DEFAULT_SERVERS: readonly FakeServerRow[] = [
  {
    name: "filesystem",
    title: "Filesystem",
    summary: "Read and write files in the workspace.",
    status: "connected",
  },
  {
    name: "github",
    title: "GitHub",
    summary: "Issues, pull requests and repository search.",
    status: "needs_auth",
    error: "The OAuth token is missing or expired.",
  },
  {
    name: "postgres",
    title: "Postgres",
    summary: "Query the project database.",
    status: "failed",
    error: "Connection refused after 3 attempts.",
  },
  {
    name: "notes",
    title: "Notes",
    summary: "Local notes server, disabled in the host configuration.",
    status: "disabled",
  },
  {
    name: "linear",
    title: "Linear",
    summary: "Issues, cycles and project updates.",
    status: "pending",
  },
]

const DEFAULT_SKILLS: readonly FakeSkillRow[] = [
  {
    id: "review",
    name: "Review",
    description: "Review a diff and report findings.",
    autoinvoke: true,
  },
  {
    id: "release",
    name: "Release",
    description: "Tag a version, draft notes and publish.",
  },
]

export interface FakeAppInventoryOptions {
  /** False simulates a host without the app surface: every call throws. */
  available?: boolean
}

export class FakeAppInventory {
  private readonly servers: FakeServerRow[]
  private readonly available: boolean

  constructor(options: FakeAppInventoryOptions = {}) {
    this.servers = DEFAULT_SERVERS.map((row) => ({ ...row }))
    this.available = options.available ?? true
  }

  async list(): Promise<AppsSnapshot> {
    this.requireAvailable()
    return {
      servers: this.servers.map((server): AppServer => {
        const row: AppServer = { name: server.name, title: server.title, status: server.status }
        if (server.error) row.error = server.error
        return row
      }),
      skills: DEFAULT_SKILLS.map((skill): AppSkill => {
        const row: AppSkill = {
          id: skill.id,
          name: skill.name,
          description: skill.description,
        }
        if (skill.autoinvoke !== undefined) row.autoinvoke = skill.autoinvoke
        return row
      }),
    }
  }

  /** Current statuses, for `fake-search.ts`; never the `summary` fields. */
  searchEntries(): FakeAppEntry[] {
    return [
      ...this.servers.map((server): FakeAppEntry => ({
        app: server.name,
        title: server.title,
        snippet: server.summary,
        kind: "server",
        status: server.status,
      })),
      ...DEFAULT_SKILLS.map((skill): FakeAppEntry => ({
        app: skill.id,
        title: skill.name,
        snippet: skill.description,
        kind: "skill",
        status: "available",
      })),
    ]
  }

  /**
   * Options `fakeSearch` needs. A host without the app surface reports `apps`
   * as disabled instead of returning hits for a surface `/apps` says is gone.
   */
  searchOptions(
    disabled: readonly SearchSource[],
    failing: readonly SearchSource[],
  ): {
    disabled: readonly SearchSource[]
    failing: readonly SearchSource[]
    apps: FakeAppEntry[]
  } {
    return {
      disabled: this.available ? disabled : [...new Set<SearchSource>([...disabled, "apps"])],
      failing,
      apps: this.searchEntries(),
    }
  }

  /**
   * Connect moves any known, enabled server to `connected`. A disabled server
   * is off in the host configuration, so connecting it is a conflict rather
   * than a fake success.
   */
  async connect(raw: string): Promise<void> {
    this.requireAvailable()
    const server = this.find(raw)
    if (server.status === "disabled") {
      throw new BackendError("conflict", "The server is disabled in the host configuration")
    }
    server.status = "connected"
    delete server.error
  }

  /**
   * Disconnect returns a server to `pending`, the state the host reports for a
   * configured server it has not connected yet. A disabled server stays
   * disabled: it was never connected.
   */
  async disconnect(raw: string): Promise<void> {
    this.requireAvailable()
    const server = this.find(raw)
    if (server.status === "disabled") return
    server.status = "pending"
    delete server.error
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new BackendError("unsupported", "The host has no app surface")
    }
  }

  private find(raw: string): FakeServerRow {
    const name = raw.trim()
    if (name.length === 0) throw new BackendError("invalid", "An app name is required")
    const server = this.servers.find((row) => row.name === name)
    if (!server) throw new BackendError("not_found", "Unknown app server")
    return server
  }
}

/** Entries for a caller that has no inventory of its own, e.g. a unit test. */
export function defaultAppEntries(): FakeAppEntry[] {
  return new FakeAppInventory().searchEntries()
}
