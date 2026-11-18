/**
 * `/api/sessions/:id/files` — the read, write and delete surface of one chat's
 * working directory. The store owns every path decision; these handlers only
 * translate a result into a status and never echo a filesystem path.
 */
import type { Context, Hono } from "hono"
import type { ChatFileInfo } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { ChatFileFailureReason } from "./chat-files-store"
import { isSafeFileName, isSafeSessionID } from "./chat-files-paths"
import { ChatFilesStore } from "./chat-files-store"
import type { EnvConfig } from "./env"
import { jsonError, payloadTooLarge } from "./http"

const INVALID_SESSION = "Session id must be a single safe path segment"
const INVALID_NAME = "File name must be a single safe path segment"
const EMPTY = "File must not be empty"
const QUOTA_CHAT = "This chat's file quota is exhausted"
const QUOTA_TOTAL = "The workspace file quota is exhausted"
const CONFLICT = "A file with this name already exists"
const UNKNOWN = "Unknown file"
const IO = "The file could not be stored"

/** RFC 6266/5987: an ASCII fallback plus the exact UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  const encoded = encodeURIComponent(name).replace(/'/g, "%27")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function writeFailure(c: Context, reason: ChatFileFailureReason, maxBytes: number) {
  switch (reason) {
    case "invalid-session":
      return jsonError(c, 400, "invalid_session", INVALID_SESSION)
    case "invalid-name":
      return jsonError(c, 400, "invalid_name", INVALID_NAME)
    case "empty":
      return jsonError(c, 400, "empty_file", EMPTY)
    case "too-large":
      return payloadTooLarge(c, maxBytes)
    case "quota-chat":
      return jsonError(c, 413, "quota_exceeded", QUOTA_CHAT)
    case "quota-total":
      return jsonError(c, 413, "quota_exceeded", QUOTA_TOTAL)
    case "name-conflict":
      return jsonError(c, 409, "name_conflict", CONFLICT)
    case "io":
      return jsonError(c, 500, "internal_error", IO)
  }
}

/** Registers the session file routes; auth and the request guards already ran. */
export function registerChatFilesRoutes(app: Hono<AppEnv>, config: EnvConfig): void {
  const store = new ChatFilesStore({
    workspaceDir: config.WORKSPACE_DIR,
    quotaPerChatBytes: config.WORKSPACE_QUOTA_PER_CHAT_BYTES,
    quotaTotalBytes: config.WORKSPACE_QUOTA_TOTAL_BYTES,
    maxFileBytes: config.WORKSPACE_MAX_FILE_BYTES,
  })

  /** A malformed id or name is the client's bug, not a missing file. */
  const rejected = (c: Context, sessionID: string, name?: string): Response | null => {
    if (!isSafeSessionID(sessionID)) {
      return jsonError(c, 400, "invalid_session", INVALID_SESSION)
    }
    if (name !== undefined && !isSafeFileName(name)) {
      return jsonError(c, 400, "invalid_name", INVALID_NAME)
    }
    return null
  }

  app.get("/api/sessions/:id/files", async (c) => {
    c.header("Cache-Control", "no-store")
    const sessionID = c.req.param("id") ?? ""
    const invalid = rejected(c, sessionID)
    if (invalid) return invalid
    return c.json({ files: await store.list(sessionID), quota: await store.usage(sessionID) })
  })

  app.get("/api/sessions/:id/files/:name", async (c) => {
    c.header("Cache-Control", "no-store")
    const sessionID = c.req.param("id") ?? ""
    const name = c.req.param("name") ?? ""
    const invalid = rejected(c, sessionID, name)
    if (invalid) return invalid
    const found = await store.read(sessionID, name)
    if (!found) return jsonError(c, 404, "file_unknown", UNKNOWN)
    c.header("Content-Type", found.file.mime)
    c.header("Content-Length", String(found.bytes.byteLength))
    c.header("Content-Disposition", contentDisposition(found.file.displayName))
    c.header("X-Content-Type-Options", "nosniff")
    // Even an uploaded HTML file is a download, not a document on this origin.
    c.header("Content-Security-Policy", "sandbox")
    return c.body(new Uint8Array(found.bytes))
  })

  /**
   * The body is the exact file bytes; the name travels in the query so a
   * `Content-Disposition` or multipart parser never sees untrusted input. The
   * route trusts `WORKSPACE_MAX_FILE_BYTES`; the node adapter and the request
   * guard cap the body at the same value before this handler runs.
   */
  app.post("/api/sessions/:id/files", async (c) => {
    c.header("Cache-Control", "no-store")
    const sessionID = c.req.param("id") ?? ""
    const invalid = rejected(c, sessionID)
    if (invalid) return invalid
    const bytes = Buffer.from(await c.req.arrayBuffer())
    if (bytes.byteLength > config.WORKSPACE_MAX_FILE_BYTES) {
      return payloadTooLarge(c, config.WORKSPACE_MAX_FILE_BYTES)
    }
    const result = await store.write(sessionID, {
      name: c.req.query("name") ?? "",
      bytes,
      origin: "upload",
    })
    if (!result.ok) {
      return writeFailure(c, result.reason, config.WORKSPACE_MAX_FILE_BYTES)
    }
    return c.json(result.file satisfies ChatFileInfo, 201)
  })

  app.delete("/api/sessions/:id/files/:name", async (c) => {
    c.header("Cache-Control", "no-store")
    const sessionID = c.req.param("id") ?? ""
    const name = c.req.param("name") ?? ""
    const invalid = rejected(c, sessionID, name)
    if (invalid) return invalid
    const result = await store.remove(sessionID, name)
    if (result === "not-found") return jsonError(c, 404, "file_unknown", UNKNOWN)
    return c.body(null, 204)
  })
}
