import type { Context, Hono } from "hono"
import type { ChatFileInfo, ChatFilesResponse } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { ChatFileFailureReason, ChatFileDraft } from "./chat-files-store"
import { ChatFilesStore } from "./chat-files-store"
import { auditChatFiles as auditWorkspace } from "./chat-files-audit"
import type { ChatFilesAudit } from "./chat-files-audit"
import { isSafeFileName, isSafeSessionID } from "./chat-files-names"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"

/** Fixed messages: a rejected name is never echoed back to the client. */
const INVALID_SESSION = "Invalid session id"
const INVALID_NAME = "Invalid file name"
const UNKNOWN_FILE = "Unknown file"

export type ChatFileFailureStatus = 400 | 409 | 413 | 500

export interface ChatFileFailure {
  ok: false
  status: ChatFileFailureStatus
  code: string
  message: string
}

export type ChatFileUploadResult = { ok: true; file: ChatFileInfo } | ChatFileFailure

/**
 * Maps a store rejection to the HTTP answer a future upload route returns.
 * Quota and size are `413`; a malformed name is a client error; a name that
 * collided with every suffix is a conflict.
 */
export function chatFileFailure(reason: ChatFileFailureReason): ChatFileFailure {
  switch (reason) {
    case "quota-chat":
    case "quota-total":
      return {
        ok: false,
        status: 413,
        code: "payload_too_large",
        message: "The chat file quota is exhausted",
      }
    case "too-large":
      return {
        ok: false,
        status: 413,
        code: "payload_too_large",
        message: "The file exceeds the upload limit",
      }
    case "invalid-session":
    case "invalid-name":
    case "empty":
      return { ok: false, status: 400, code: "invalid_request", message: INVALID_NAME }
    case "name-conflict":
      return { ok: false, status: 409, code: "name_conflict", message: "The file name is taken" }
    case "io":
      return {
        ok: false,
        status: 500,
        code: "internal_error",
        message: "The file could not be stored",
      }
  }
}

/**
 * Server-side upload entry point. The browser has no upload UI yet, so this is
 * not mounted as a route; issue #21 owns the streaming body and the composer.
 * Tests pin the quota-before-write behaviour and the status mapping here.
 */
export async function uploadChatFile(
  store: ChatFilesStore,
  sessionID: string,
  draft: ChatFileDraft,
): Promise<ChatFileUploadResult> {
  const result = await store.write(sessionID, draft)
  return result.ok ? result : chatFileFailure(result.reason)
}

export interface ChatFilesRouteDeps {
  config: EnvConfig
  /** Injected by tests; the default follows `WORKSPACE_DIR` and the quotas. */
  store?: ChatFilesStore
}

export function createChatFilesStore(config: EnvConfig): ChatFilesStore {
  return new ChatFilesStore({
    workspaceDir: config.WORKSPACE_DIR,
    quotaPerChatBytes: config.WORKSPACE_QUOTA_PER_CHAT_BYTES,
    quotaTotalBytes: config.WORKSPACE_QUOTA_TOTAL_BYTES,
    maxFileBytes: config.WORKSPACE_MAX_FILE_BYTES,
  })
}

/**
 * `filename` carries an ASCII fallback for old clients and `filename*` the
 * exact UTF-8 name. The stored name is already one safe segment; the fallback
 * still replaces quotes and non-ASCII so the header cannot break.
 */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function invalid(c: Context<AppEnv>): Response {
  return jsonError(c, 400, "invalid_request", INVALID_NAME)
}

/** Registers the read/delete half of the per-chat file API. */
export function registerChatFilesRoutes(app: Hono<AppEnv>, deps: ChatFilesRouteDeps): void {
  const store = deps.store ?? createChatFilesStore(deps.config)

  app.get("/api/sessions/:id/files", async (c) => {
    const sessionID = c.req.param("id") ?? ""
    if (!isSafeSessionID(sessionID)) {
      return jsonError(c, 400, "invalid_request", INVALID_SESSION)
    }
    c.header("Cache-Control", "no-store")
    const [files, quota] = await Promise.all([store.list(sessionID), store.usage(sessionID)])
    return c.json({ files, quota } satisfies ChatFilesResponse)
  })

  // A regex segment keeps a hostile path inside the handler so it is rejected
  // with `400` instead of disappearing into Hono's `404`; the store then sees
  // one name and still rejects every separator.
  app.get("/api/sessions/:id/files/:name{.+}", async (c) => {
    const sessionID = c.req.param("id") ?? ""
    const name = c.req.param("name")
    if (!isSafeSessionID(sessionID)) {
      return jsonError(c, 400, "invalid_request", INVALID_SESSION)
    }
    if (name === undefined || !isSafeFileName(name)) return invalid(c)
    c.header("Cache-Control", "no-store")
    const found = await store.read(sessionID, name)
    if (!found) return jsonError(c, 404, "file_unknown", UNKNOWN_FILE)
    c.header("Content-Type", found.file.mime)
    c.header("Content-Disposition", contentDisposition(found.file.displayName))
    c.header("X-Content-Type-Options", "nosniff")
    return c.body(new Uint8Array(found.bytes))
  })

  app.delete("/api/sessions/:id/files/:name{.+}", async (c) => {
    const sessionID = c.req.param("id") ?? ""
    const name = c.req.param("name")
    if (!isSafeSessionID(sessionID)) {
      return jsonError(c, 400, "invalid_request", INVALID_SESSION)
    }
    if (name === undefined || !isSafeFileName(name)) return invalid(c)
    c.header("Cache-Control", "no-store")
    const result = await store.remove(sessionID, name)
    if (result === "not-found") return jsonError(c, 404, "file_unknown", UNKNOWN_FILE)
    return c.body(null, 204)
  })
}

const AUDIT_LABELS: ReadonlyArray<[keyof ChatFilesAudit, string]> = [
  ["withoutSession", "chat directories without a session"],
  ["withoutMetadata", "files without metadata"],
  ["withoutFile", "metadata rows without a file"],
]

/**
 * Boot check: compares the workspace with the sessions the host reports. It
 * only reports; nothing on disk is ever deleted here.
 */
export async function auditChatFiles(
  config: EnvConfig,
  sessionIDs: Iterable<string>,
  store: ChatFilesStore = createChatFilesStore(config),
): Promise<ChatFilesAudit> {
  return auditWorkspace(config.WORKSPACE_DIR, sessionIDs, (sessionID) => store.readIndex(sessionID))
}

/** Logs one block per non-empty category; returns whether anything was found. */
export function reportChatFiles(
  report: ChatFilesAudit,
  log: (message: string) => void = console.warn,
): boolean {
  let found = false
  for (const [key, label] of AUDIT_LABELS) {
    const entries = report[key]
    if (entries.length === 0) continue
    found = true
    log(`[openchat] chat files: ${entries.length} ${label} (not deleted):`)
    for (const entry of entries) log(`  ${entry}`)
  }
  return found
}
