/**
 * Tool schemas for the memory MCP server. Every tool is array-first so one
 * Code Mode script can ask several questions or write a batch in one step.
 */
const RETRY = "Fix exactly what the error names and retry at most twice."

export const MEMORY_TOOLS = [
  {
    name: "mem_index",
    title: "Read the memory index",
    description:
      "Return INDEX.md, the ranked push layer injected into sessions. No arguments. " +
      "Use mem_find for detail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mem_find",
    title: "Search agent memory",
    description:
      "Search active facts by keyword/topic/tag. `queries` is an array (max 20); each " +
      "returns compact matches. `tags` filters by tag, `since` by last confirmation. " +
      "Deleted, superseded and expired facts never match; use mem_get for those.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "1–20 queries." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tag filter." },
        since: { type: "string", description: "Optional ISO timestamp lower bound." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Matches per query." },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_update",
    title: "Update memory facts",
    description:
      "Patch facts by id. `updates` is an array (max 50) of {id, text?, topic?, tags?, " +
      "trust?, status?, expiresAt?, confirm?}. A text edit or `confirm: true` resets " +
      "the TTL clock; a read never does. " +
      RETRY,
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              topic: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              trust: { enum: ["explicit", "observed", "inferred"] },
              status: { enum: ["active", "superseded", "expired", "deleted"] },
              expiresAt: { type: ["string", "null"] },
              confirm: { type: "boolean" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_write",
    title: "Write memory facts",
    description:
      "Append facts (max 50). Each entry is {text, topic, tags?, trust?, source?, " +
      "supersedes?, expiresAt?}. Search first: near-identical active facts are " +
      "rejected with `duplicateOf`. Secrets and instruction-shaped text are rejected. " +
      "`supersedes` keeps the old fact and links it. Returns per-entry results. " +
      RETRY,
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              topic: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              trust: { enum: ["explicit", "observed", "inferred"] },
              source: {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  messageID: { type: "string" },
                  at: { type: "string" },
                },
                additionalProperties: false,
              },
              supersedes: { type: "array", items: { type: "string" } },
              expiresAt: { type: ["string", "null"] },
            },
            required: ["text", "topic"],
            additionalProperties: false,
          },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_get",
    title: "Read memory facts by id",
    description:
      "Full records for chosen ids (max 100), including superseded, expired and " +
      "deleted rows. `fields` optionally narrows the returned keys.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "1–100 ids." },
        fields: { type: "array", items: { type: "string" }, description: "Optional keys." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_delete",
    title: "Delete memory facts",
    description:
      "Soft-delete facts by id (max 100) with a reason. Never refused; the rows stay " +
      "readable through mem_get and the audit.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        reason: { type: "string", description: "Why these facts are no longer true." },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_prune",
    title: "Prune memory",
    description:
      "Find or apply cleanup candidates. Dry-run by default: nothing is deleted " +
      "unless `dryRun: false`. Reasons: stale, superseded, duplicate, oversized, " +
      "over-budget. `maxAgeDays`, `superseded` and `maxBytes` tune the scan.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Defaults to true." },
        maxAgeDays: { type: "integer", minimum: 1 },
        superseded: { type: "boolean", description: "Include superseded rows." },
        maxBytes: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mem_stats",
    title: "Memory store statistics",
    description:
      "Counts by status, topic list, byte usage against the caps and the index size.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const

export const MEMORY_TOOL_NAMES = MEMORY_TOOLS.map((tool) => tool.name)

export type MemoryToolName = (typeof MEMORY_TOOLS)[number]["name"]
