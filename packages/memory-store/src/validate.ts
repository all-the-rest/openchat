/**
 * The write boundary. Memory text enters the system context, so it is checked
 * for secrets and instruction-like payloads before it reaches the store; both
 * refusals carry a stable code the UI and the tool can show verbatim. The same
 * module validates field shapes and computes the near-duplicate signal used by
 * search-before-write dedupe.
 */
import { Buffer } from "node:buffer"
import {
  DUPLICATE_THRESHOLD,
  MAX_TAG_BYTES,
  MAX_TAGS,
  MAX_TEXT_BYTES,
  MAX_TOPIC_BYTES,
} from "./limits"
import type { FactDraft, MemoryRejectCode, MemorySource, MemoryTrust, UpdateSpec } from "./types"

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SECRET_KEY = /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*\S+/i
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/
const GITHUB_PAT = /\bghp_[A-Za-z0-9]{20,}\b/
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const INSTRUCTION = /\bignore\s+(all\s+)?previous\b/i
const SYSTEM_LINE = /^\s*system\s*:/im

export type CheckResult = { ok: true } | { ok: false; code: MemoryRejectCode; message: string }

function bad(code: MemoryRejectCode, message: string): CheckResult {
  return { ok: false, code, message }
}

/** Rejections name the class only, never the offending text. */
export function checkText(text: string): CheckResult {
  if (SECRET_KEY.test(text) || OPENAI_KEY.test(text) || GITHUB_PAT.test(text)) {
    return bad("secret", "secret: text looks like a credential and was not stored")
  }
  if (PRIVATE_KEY.test(text)) {
    return bad("secret", "secret: a private-key block was not stored")
  }
  if (INSTRUCTION.test(text) || SYSTEM_LINE.test(text)) {
    return bad("instruction", "instruction: text looks like a prompt instruction and was not stored")
  }
  return { ok: true }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readText(value: unknown, field: string, max: number): CheckResult {
  if (typeof value !== "string") return bad("invalid", `${field}: must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return bad("invalid", `${field}: must not be empty`)
  if (CONTROL.test(trimmed)) return bad("invalid", `${field}: contains a control character`)
  if (bytes(trimmed) > max) return bad("too-large", `${field}: exceeds the byte cap`)
  return { ok: true }
}

export interface NormalizedDraft {
  text: string
  topic: string
  tags: string[]
  trust: MemoryTrust
  source?: MemorySource
  id?: string
  createdAt?: string
  expiresAt?: string
}

function readTags(value: unknown): CheckResult & { tags?: string[] } {
  if (value === undefined) return { ok: true }
  if (!Array.isArray(value)) return bad("invalid", "tags: must be an array")
  if (value.length > MAX_TAGS) return bad("too-large", "tags: too many entries")
  const tags: string[] = []
  for (const item of value) {
    const checked = readText(item, "tags", MAX_TAG_BYTES)
    if (!checked.ok) return checked
    const tag = (item as string).trim().toLowerCase()
    if (!tags.includes(tag)) tags.push(tag)
  }
  return { ok: true, tags }
}

function readTrust(value: unknown): CheckResult & { trust?: MemoryTrust } {
  if (value === undefined) return { ok: true, trust: "inferred" }
  if (value !== "explicit" && value !== "observed" && value !== "inferred") {
    return bad("invalid", "trust: must be explicit, observed or inferred")
  }
  return { ok: true, trust: value }
}

function readSource(value: unknown): CheckResult & { source?: MemorySource } {
  if (value === undefined) return { ok: true }
  if (!isObject(value)) return bad("invalid", "source: must be an object")
  for (const key of ["sessionID", "messageID", "at"] as const) {
    const field = value[key]
    if (typeof field !== "string" || field.length === 0 || field.length > 200) {
      return bad("invalid", `source.${key}: must be a short string`)
    }
  }
  return {
    ok: true,
    source: {
      sessionID: value.sessionID as string,
      messageID: value.messageID as string,
      at: value.at as string,
    },
  }
}

/** Validates one draft and returns the normalised fields the store persists. */
export function validateDraft(value: unknown): CheckResult & { draft?: NormalizedDraft } {
  if (!isObject(value)) return bad("invalid", "entry: must be an object")
  const text = readText(value.text, "text", MAX_TEXT_BYTES)
  if (!text.ok) return text
  const hygiene = checkText(value.text as string)
  if (!hygiene.ok) return hygiene
  const topic = readText(value.topic, "topic", MAX_TOPIC_BYTES)
  if (!topic.ok) return topic
  const tags = readTags(value.tags)
  if (!tags.ok) return tags
  const trust = readTrust(value.trust)
  if (!trust.ok) return trust
  const source = readSource(value.source)
  if (!source.ok) return source
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.length === 0)) {
    return bad("invalid", "id: must be a non-empty string")
  }
  return {
    ok: true,
    draft: {
      text: (value.text as string).trim(),
      topic: (value.topic as string).trim(),
      tags: tags.tags ?? [],
      trust: trust.trust ?? "inferred",
      ...(source.source ? { source: source.source } : {}),
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
      ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
    },
  }
}

export interface NormalizedUpdate {
  id: string
  text?: string
  topic?: string
  tags?: string[]
  trust?: MemoryTrust
  status?: UpdateSpec["status"]
  confirm: boolean
  expiresAt?: string
  reason?: string
}

export function validateUpdate(value: unknown): CheckResult & { update?: NormalizedUpdate } {
  if (!isObject(value)) return bad("invalid", "update: must be an object")
  if (typeof value.id !== "string" || value.id.length === 0) {
    return bad("invalid", "id: must be a non-empty string")
  }
  const result: NormalizedUpdate = { id: value.id, confirm: value.confirm === true }
  if (value.text !== undefined) {
    const text = readText(value.text, "text", MAX_TEXT_BYTES)
    if (!text.ok) return text
    const hygiene = checkText(value.text as string)
    if (!hygiene.ok) return hygiene
    result.text = (value.text as string).trim()
  }
  if (value.topic !== undefined) {
    const topic = readText(value.topic, "topic", MAX_TOPIC_BYTES)
    if (!topic.ok) return topic
    result.topic = (value.topic as string).trim()
  }
  if (value.tags !== undefined) {
    const tags = readTags(value.tags)
    if (!tags.ok) return tags
    result.tags = tags.tags
  }
  if (value.trust !== undefined) {
    const trust = readTrust(value.trust)
    if (!trust.ok) return trust
    result.trust = trust.trust
  }
  if (value.status !== undefined) {
    if (
      value.status !== "active" &&
      value.status !== "superseded" &&
      value.status !== "expired" &&
      value.status !== "deleted"
    ) {
      return bad("invalid", "status: unknown status")
    }
    result.status = value.status
  }
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string") return bad("invalid", "expiresAt: must be a string")
    result.expiresAt = value.expiresAt
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== "string" || bytes(value.reason) > 500) {
      return bad("invalid", "reason: must be a short string")
    }
    result.reason = value.reason
  }
  return { ok: true, update: result }
}

/** Lower-cased word bag with punctuation removed, used for duplicate detection. */
export function wordBag(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1)
  return new Set(words)
}

/** Token-set Jaccard similarity, in [0, 1]. */
export function similarity(left: string, right: string): number {
  const a = wordBag(left)
  const b = wordBag(right)
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function isDuplicate(text: string, other: string): boolean {
  return similarity(text, other) >= DUPLICATE_THRESHOLD
}
