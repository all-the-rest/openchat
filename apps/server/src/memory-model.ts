import { createHash, randomUUID } from "node:crypto"
import { MEMORY_KINDS } from "@openchat/contracts"
import type {
  MemoryAuditEntry, MemoryFact, MemoryTrust, MemoryWriteInput,
} from "@openchat/contracts"

/**
 * Pure fact rules: identity, checksums, validation, TTL and ranking. The file
 * layer (`memory-files.ts`) owns the bytes and the store (`memory-store.ts`)
 * owns lifecycle operations, so this module has no filesystem import.
 */
export const DAY_MS = 86_400_000
export const TTL_DAYS = 90
export const TEXT_MAX_BYTES = 8192
export const FIND_LIMIT = 50
export const TRUST_RANK: Record<MemoryTrust, number> = { explicit: 3, observed: 2, inferred: 1 }

/** Clean-room write-boundary patterns (§6.9). Memory is data, never directives. */
const BRAND = /\b(chatgpt|openai|claude|gemini|copilot|cursor)\b/i
const REFERENCE_PATH = /references[\/\\]raw[\/\\]|docs[\/\\]reference[\/\\]?/i
const SECRET = /\b(password|passphrase|api[ -]?key|private[ -]?key|bearer|token)\b/i
const INSTRUCTION = /\b(ignore previous|disregard)\b|\bsystem\s*:|\byou are\b/i

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Deterministic, key-sorted JSON so the checksum is independent of field order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export function digest(fact: Omit<MemoryFact, "checksum">): string {
  return createHash("sha256").update(canonical(fact)).digest("hex")
}

export function withChecksum(fact: MemoryFact): MemoryFact {
  const rest = { ...fact } as Partial<MemoryFact>
  delete rest.checksum
  return { ...rest, checksum: digest(rest as Omit<MemoryFact, "checksum">) } as MemoryFact
}

export function isFact(value: unknown): value is MemoryFact {
  if (!isObject(value)) return false
  const strings = ["id", "kind", "text", "topic", "trust", "status", "createdAt", "lastConfirmedAt", "checksum"]
  return strings.every((key) => typeof value[key] === "string")
    && Array.isArray(value.tags) && isObject(value.source) && Array.isArray(value.supersedes)
}

export function isAuditEntry(value: unknown): value is MemoryAuditEntry {
  return isObject(value)
    && typeof value.at === "string" && typeof value.actor === "string"
    && typeof value.action === "string" && typeof value.reason === "string"
    && Array.isArray(value.ids)
}

export function newFactId(): string {
  return `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`
}

export function expiryFor(trust: MemoryTrust, at: number): string | undefined {
  return trust === "explicit" ? undefined : new Date(at + TTL_DAYS * DAY_MS).toISOString()
}

export function isExpired(fact: MemoryFact, at: number): boolean {
  return fact.status === "active" && fact.expiresAt !== undefined && Date.parse(fact.expiresAt) <= at
}

export function buildFact(input: MemoryWriteInput, id: string, at: number): MemoryFact {
  const trust = input.trust ?? "inferred"
  const base: Omit<MemoryFact, "checksum"> = {
    id, kind: input.kind, text: input.text, topic: input.topic,
    tags: input.tags ?? [], source: input.source ?? {}, trust,
    status: "active", supersedes: [], createdAt: new Date(at).toISOString(),
    lastConfirmedAt: new Date(at).toISOString(), expiresAt: input.expiresAt ?? expiryFor(trust, at),
  }
  return { ...base, checksum: digest(base) }
}

/** Returns the first violated boundary rule, or `null`. */
export function validateInput(input: unknown): string | null {
  if (!isObject(input)) return "input must be an object"
  if (!(MEMORY_KINDS as readonly string[]).includes(String(input.kind))) return "invalid kind"
  if (typeof input.text !== "string" || input.text.trim() === "") return "text must not be empty"
  if (Buffer.byteLength(input.text, "utf8") > TEXT_MAX_BYTES) return "text is oversized"
  if (typeof input.topic !== "string" || input.topic.trim() === "") return "topic must not be empty"
  const text = `${input.topic}\n${input.text}`.toLowerCase()
  if (BRAND.test(text)) return "text contains a reference-product brand name"
  if (REFERENCE_PATH.test(text)) return "text contains a reference path"
  if (SECRET.test(text)) return "text contains a secret-like pattern"
  if (INSTRUCTION.test(text)) return "text contains an instruction-like payload"
  return null
}

export function scoreFact(fact: MemoryFact, terms: string[], at: number): number {
  let score = 0
  let hits = 0
  for (const term of terms) {
    const count = fact.text.toLowerCase().split(term).length - 1
    let weight = count > 0 ? 1 + Math.log(count) : 0
    if (fact.topic.toLowerCase().includes(term)) weight += 6
    if (fact.tags.some((tag) => tag.toLowerCase().includes(term))) weight += 4
    if (weight > 0) hits += 1
    score += weight
  }
  if (hits === 0) return 0
  const recency = Math.max(0, 1 - (at - Date.parse(fact.createdAt)) / (365 * DAY_MS))
  return score + hits * 0.5 + recency + TRUST_RANK[fact.trust] * 0.1
}
