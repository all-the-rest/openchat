import { createHash, timingSafeEqual } from "node:crypto"
import type { Hono } from "hono"
import {
  MEMORY_INDEX_KEY, MEMORY_KINDS, MEMORY_STATUS, MEMORY_TRUST,
  memoryUpdateInputSchema, memoryWriteInputSchema,
} from "@openchat/contracts"
import type {
  MemoryAuditEntry, MemoryFact, MemoryOp, MemoryOpResult, MemoryUpdateInput,
} from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE, INVALID_JSON, invalidMessage, jsonError, payloadTooLarge, readJson,
} from "./http"
import { clientAddress } from "./middleware"
import type { createMemoryStore } from "./memory-store"
import { FixedWindowThrottle } from "./throttle"

/**
 * HTTP layer for option-B memory. `POST /internal/memory` is the thin MCP
 * client's single write/read path; `/api/memory` is the owner's override view.
 * Both talk to the same BFF-owned store, so there is one writer and one layout.
 */
export const INTERNAL_MEMORY_PATH = "/internal/memory"
export const PUBLIC_MEMORY_PATH = "/api/memory"
/** A batch of facts is larger than a generic JSON envelope. */
export const MEMORY_BODY_MAX_BYTES = 1024 * 1024
export const MEMORY_OP_LIMIT = 60
export const MEMORY_OP_WINDOW_MS = 60_000
/** Active sessions are a hint for re-puts, not durable state. */
export const MAX_ACTIVE_MEMORY_SESSIONS = 512

type MemoryStore = ReturnType<typeof createMemoryStore>
type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const UNAVAILABLE_MESSAGE = "Memory storage is not configured"
const INVALID_BODY_MESSAGE = "body must be a JSON object"
const OP_NAMES = new Set(["index", "find", "get", "write", "update", "delete", "prune", "stats"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function ok<T>(value: T): Checked<T> { return { ok: true, value } }
function fail<T>(error: string): Checked<T> { return { ok: false, error } }

/** Constant-time bearer check; the hash hides the length as well. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  const provided = match?.[1]
  if (!provided) return false
  const left = createHash("sha256").update(provided).digest()
  const right = createHash("sha256").update(expected).digest()
  return timingSafeEqual(left, right)
}

function hasJsonContentType(header: string | undefined): boolean {
  const type = header ?? ""
  return type.split(";")[0]?.trim().toLowerCase() === "application/json"
}

// Field checks keep the route dependency-free; the contracts' schemas still
// validate every write/update entry before it reaches the store.
function checkString(
  body: Record<string, unknown>, key: string, max: number, required: boolean,
): string | undefined {
  const raw = body[key]
  if (raw === undefined) return required ? `${key} is required` : undefined
  return typeof raw === "string" && raw.length > 0 && raw.length <= max
    ? undefined : `${key} must be a string`
}
function checkStrings(
  body: Record<string, unknown>, key: string, max: number, required: boolean,
): string | undefined {
  const raw = body[key]
  if (raw === undefined) return required ? `${key} is required` : undefined
  return Array.isArray(raw) && raw.length <= max && (!required || raw.length > 0)
    && raw.every((item) => typeof item === "string" && item.length > 0)
    ? undefined : `${key} must be an array of strings`
}
function checkInt(
  body: Record<string, unknown>, key: string, min: number, max: number, required: boolean,
): string | undefined {
  const raw = body[key]
  if (raw === undefined) return required ? `${key} is required` : undefined
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max
    ? undefined : `${key} must be an integer between ${min} and ${max}`
}
function checkBool(
  body: Record<string, unknown>, key: string, required: boolean,
): string | undefined {
  const raw = body[key]
  if (raw === undefined) return required ? `${key} is required` : undefined
  return typeof raw === "boolean" ? undefined : `${key} must be a boolean`
}
function checkEnum(
  body: Record<string, unknown>, key: string, values: readonly string[],
): string | undefined {
  const raw = body[key]
  return raw === undefined || (typeof raw === "string" && values.includes(raw))
    ? undefined : `${key} must be one of ${values.join(", ")}`
}

/** Validates one internal operation. Batches are validated entry by entry. */
function validateOp(body: unknown): Checked<MemoryOp> {
  if (!isRecord(body)) return fail(INVALID_BODY_MESSAGE)
  const name = body.op
  if (typeof name !== "string" || !OP_NAMES.has(name)) return fail("unknown op")
  let error: string | undefined
  switch (name) {
    case "index":
    case "stats":
      break
    case "find":
      error = checkStrings(body, "queries", 50, true) ?? checkStrings(body, "tags", 50, false)
        ?? checkString(body, "since", 40, false) ?? checkInt(body, "limit", 1, 200, false)
      break
    case "get":
      error = checkStrings(body, "ids", 200, true) ?? checkStrings(body, "fields", 30, false)
      break
    case "write":
    case "update": {
      const key = name === "write" ? "inputs" : "updates"
      error = checkString(body, "actor", 120, true)
      const entries = body[key]
      if (!error && (!Array.isArray(entries) || entries.length < 1 || entries.length > 100)) {
        error = `${key} must be a non-empty array of at most 100 entries`
      }
      if (!error) {
        for (const entry of entries as unknown[]) {
          const parsed = name === "write"
            ? memoryWriteInputSchema.safeParse(entry)
            : memoryUpdateInputSchema.safeParse(entry)
          if (!parsed.success) { error = invalidMessage(parsed.error); break }
        }
      }
      break
    }
    case "delete":
      error = checkStrings(body, "ids", 200, true) ?? checkString(body, "reason", 500, true)
        ?? checkString(body, "actor", 120, true)
      break
    case "prune":
      error = checkBool(body, "dryRun", true) ?? checkInt(body, "maxAgeDays", 1, 36500, false)
        ?? checkBool(body, "superseded", false)
        ?? checkInt(body, "maxBytes", 1, 1024 * 1024 * 1024, false)
        ?? checkString(body, "actor", 120, true)
      break
  }
  return error ? fail(error) : ok(body as unknown as MemoryOp)
}

const MUTATING_OPS = new Set<MemoryOp["op"]>(["write", "update", "delete", "prune"])

/** The narrow port another builder added to `ChatBackend`. */
export interface MemoryInstructionTarget {
  putInstruction(sessionID: string, key: string, value: string): Promise<void>
  /** Optional: recovers sessions that pre-date a BFF restart. */
  listSessions?(): Promise<ReadonlyArray<{ id: string }>>
}

/** Accepts a single port or a list; anything else silently disables re-puts. */
function targetsFrom(backends: unknown): MemoryInstructionTarget[] {
  const list = Array.isArray(backends) ? backends : [backends]
  return list.filter(
    (item): item is MemoryInstructionTarget =>
      typeof item === "object" && item !== null &&
      typeof (item as { putInstruction?: unknown }).putInstruction === "function",
  )
}

/**
 * Sessions are tracked once per process, shared by the internal and public
 * registrars, so a mutation through either route re-puts into both sets.
 */
const activeSessions = new Set<string>()

export interface MemoryInvalidator {
  /** Remembers a session created through the public route. */
  noteSession(sessionID: string): void
  /** Re-puts the current index into every remembered session. */
  invalidate(): Promise<void>
  /** Active session count; exposed for tests. */
  readonly active: number
}

export function createMemoryInvalidator(
  backends: unknown, store: MemoryStore,
): MemoryInvalidator {
  const targets = targetsFrom(backends)
  const note = (sessionID: unknown): void => {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    activeSessions.delete(sessionID)
    if (activeSessions.size >= MAX_ACTIVE_MEMORY_SESSIONS) {
      const oldest = activeSessions.values().next()
      if (!oldest.done) activeSessions.delete(oldest.value)
    }
    activeSessions.add(sessionID)
  }
  /**
   * A restart empties the module-level set, so the first mutation would reach
   * no session. Reading the backend's list before the re-put restores the
   * sessions that already existed; the cap above keeps the set bounded.
   */
  const discover = async (): Promise<void> => {
    await Promise.all(targets.map(async (target) => {
      if (typeof target.listSessions !== "function") return
      try {
        for (const session of await target.listSessions()) note(session.id)
      } catch { /* host */ }
    }))
  }
  return {
    noteSession(sessionID) {
      note(sessionID)
    },
    async invalidate() {
      if (targets.length === 0) return
      await discover()
      if (activeSessions.size === 0) return
      const { index } = store.index()
      await Promise.all(targets.flatMap((target) =>
        [...activeSessions].map(async (sessionID) => {
          try { await target.putInstruction(sessionID, MEMORY_INDEX_KEY, index) } catch { /* host */ }
        })))
    },
    get active() { return activeSessions.size },
  }
}

/** Maps one validated op onto one synchronous store call. */
function dispatch(store: MemoryStore, op: MemoryOp): MemoryOpResult {
  switch (op.op) {
    case "index": {
      const result = store.index()
      return { ok: true, index: result.index, entries: result.entries, dropped: result.dropped }
    }
    case "find":
      return { ok: true, rows: store.find(op) }
    case "get":
      return { ok: true, facts: store.get(op.ids, op.fields) }
    case "write":
      return { ok: true, ids: store.write(op.inputs, op.actor).map((fact) => fact.id) }
    case "update":
      return { ok: true, facts: store.update(op.updates, op.actor) }
    case "delete":
      store.remove({ ids: op.ids, reason: op.reason }, op.actor)
      return { ok: true, ids: op.ids }
    case "prune": {
      const result = store.prune(op, op.actor)
      return { ok: true, candidates: result.candidates, removed: result.removed }
    }
    case "stats":
      return { ok: true, stats: store.stats() }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Memory operation failed"
}

export interface MemoryInternalRouteDeps {
  config: EnvConfig
  store: MemoryStore
  /** Optional, used only when no shared invalidator was supplied. */
  backends?: unknown
  /** Shared with the public routes; owns the active-session set. */
  invalidator?: MemoryInvalidator
  /** Injected throttle clock; tests advance it. */
  now?: () => number
}

/**
 * `POST /internal/memory`. The token is the whole authentication: this path is
 * not under `/api/*`, so the session guards never run. Authentication comes
 * before the budget, exactly as on the artifact write path.
 */
export function registerMemoryInternalRoute(
  app: Hono<AppEnv>, deps: MemoryInternalRouteDeps,
): void {
  const { config, store } = deps
  const token = config.MEMORY_INTERNAL_TOKEN
  const invalidator = deps.invalidator ?? createMemoryInvalidator(deps.backends, store)
  const throttle = new FixedWindowThrottle({
    limit: MEMORY_OP_LIMIT, windowMs: MEMORY_OP_WINDOW_MS, now: deps.now,
  })

  app.post(INTERNAL_MEMORY_PATH, async (c) => {
    c.header("Cache-Control", "no-store")
    if (token.length === 0) {
      return jsonError(c, 503, "memory_unavailable", UNAVAILABLE_MESSAGE)
    }
    if (!bearerMatches(c.req.header("authorization"), token)) {
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    if (!hasJsonContentType(c.req.header("content-type"))) {
      return jsonError(c, 415, "unsupported_media_type", "Content-Type must be application/json")
    }
    const address = clientAddress(c, config.TRUST_PROXY)
    const status = throttle.check(address)
    if (status.limited) {
      c.header("Retry-After", String(status.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many memory operations")
    }
    const body = await readJson(c, MEMORY_BODY_MAX_BYTES)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c, MEMORY_BODY_MAX_BYTES)
    if (body === INVALID_JSON) return jsonError(c, 400, "memory_invalid", INVALID_BODY_MESSAGE)
    const checked = validateOp(body)
    if (!checked.ok) return jsonError(c, 400, "memory_invalid", checked.error)
    let result: MemoryOpResult
    try {
      result = dispatch(store, checked.value)
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) } satisfies MemoryOpResult, 400)
    }
    throttle.record(address)
    if (MUTATING_OPS.has(checked.value.op)) await invalidator.invalidate()
    return c.json(result)
  })
}

const PATCH_FIELDS = ["text", "topic", "tags", "kind", "trust", "status", "confirm"]

/** Validates an owner edit; `kind` is accepted for forward compatibility. */
function validatePatch(body: unknown): Checked<Record<string, unknown>> {
  if (!isRecord(body)) return fail(INVALID_BODY_MESSAGE)
  for (const key of Object.keys(body)) {
    if (!PATCH_FIELDS.includes(key)) return fail(`unknown field: ${key}`)
  }
  const error = checkString(body, "text", 8192, false) ?? checkString(body, "topic", 200, false)
    ?? checkStrings(body, "tags", 50, false) ?? checkEnum(body, "kind", MEMORY_KINDS)
    ?? checkEnum(body, "trust", MEMORY_TRUST) ?? checkEnum(body, "status", MEMORY_STATUS)
    ?? checkBool(body, "confirm", false)
  if (error) return fail(error)
  const parsed = memoryUpdateInputSchema.safeParse({ id: "validate", ...body })
  if (!parsed.success) return fail(invalidMessage(parsed.error))
  return ok(body)
}

export interface MemoryPublicRouteDeps {
  config: EnvConfig
  store: MemoryStore
  backends: unknown
  invalidator: MemoryInvalidator
}

/**
 * Owner override routes. The `/api/*` auth middleware runs before them, so an
 * anonymous request is a 401 without any check here. Every write re-uses the
 * same invalidator as the internal path.
 */
export function registerMemoryRoutes(
  app: Hono<AppEnv>, deps: MemoryPublicRouteDeps,
): void {
  const { store, invalidator } = deps
  const actor = (c: { get(key: "user"): string }): string => c.get("user") || "owner"

  app.get(PUBLIC_MEMORY_PATH, (c) => {
    const facts: MemoryFact[] = store.facts()
    const audit: MemoryAuditEntry[] = store.audit()
    return c.json({ facts, audit, index: store.index().index })
  })

  // Registered before `/:id` so "export" cannot be read as a fact id.
  app.get(`${PUBLIC_MEMORY_PATH}/export`, (c) => {
    const payload = {
      facts: store.facts(), audit: store.audit(), index: store.index().index,
      exportedAt: new Date().toISOString(),
    }
    c.header("Content-Type", "application/json; charset=utf-8")
    c.header("Content-Disposition", 'attachment; filename="openchat-memory.json"')
    c.header("X-Content-Type-Options", "nosniff")
    return c.body(JSON.stringify(payload, null, 2))
  })

  app.patch(`${PUBLIC_MEMORY_PATH}/:id`, async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const checked = validatePatch(body ?? {})
    if (!checked.ok) return jsonError(c, 400, "invalid_request", checked.error)
    const update = { id: c.req.param("id"), ...checked.value } as unknown as MemoryUpdateInput
    const updated = store.update([update], actor(c))
    await invalidator.invalidate()
    const fact = updated[0]
    if (!fact) return jsonError(c, 404, "not_found", "Memory fact not found")
    return c.json(fact)
  })

  app.delete(`${PUBLIC_MEMORY_PATH}/:id`, async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const error = isRecord(body) ? checkString(body, "reason", 500, true) : INVALID_BODY_MESSAGE
    if (error) return jsonError(c, 400, "invalid_request", error)
    store.remove({ ids: [c.req.param("id")], reason: (body as { reason: string }).reason }, actor(c))
    await invalidator.invalidate()
    return c.json({ ok: true })
  })
}
