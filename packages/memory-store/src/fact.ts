import { createHash } from "node:crypto"
import type { MemoryFact, MemoryStatus, MemoryTrust } from "@openchat/contracts"

/** Fact shape, checksum and stored-line validation. */

const ID_PATTERN = /^mem_[a-z0-9]{8,32}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Canonical payload; `checksum` itself is not part of it. */
export function factChecksum(fact: Omit<MemoryFact, "checksum">): string {
  return sha256(
    JSON.stringify({
      id: fact.id,
      text: fact.text,
      topic: fact.topic,
      tags: fact.tags,
      source: fact.source,
      trust: fact.trust,
      status: fact.status,
      supersedes: fact.supersedes,
      createdAt: fact.createdAt,
      lastConfirmedAt: fact.lastConfirmedAt,
      expiresAt: fact.expiresAt,
    }),
  )
}

export function rehash(fact: MemoryFact): MemoryFact {
  const { checksum: _ignored, ...rest } = fact
  return { ...rest, checksum: factChecksum(rest) }
}

function isTrust(value: unknown): value is MemoryTrust {
  return value === "explicit" || value === "observed" || value === "inferred"
}

function isStatus(value: unknown): value is MemoryStatus {
  return value === "active" || value === "superseded" || value === "expired" || value === "deleted"
}

export function isStoredFact(value: unknown): value is MemoryFact {
  if (!isRecord(value)) return false
  const source = value.source
  if (!isRecord(source)) return false
  if (
    typeof value.id !== "string" || !ID_PATTERN.test(value.id) ||
    typeof value.text !== "string" || value.text.length === 0 ||
    typeof value.topic !== "string" || value.topic.length === 0 ||
    !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string") ||
    typeof source.sessionID !== "string" || typeof source.messageID !== "string" ||
    typeof source.at !== "string" || !isTrust(value.trust) || !isStatus(value.status) ||
    !Array.isArray(value.supersedes) ||
    !value.supersedes.every((id) => typeof id === "string") ||
    typeof value.createdAt !== "string" || typeof value.lastConfirmedAt !== "string" ||
    (value.expiresAt !== null && typeof value.expiresAt !== "string") ||
    typeof value.checksum !== "string"
  ) {
    return false
  }
  const fact = value as unknown as MemoryFact
  return factChecksum(fact) === fact.checksum
}

export function iso(value: Date): string {
  return value.toISOString()
}

export function textBytes(fact: MemoryFact): number {
  return Buffer.byteLength(JSON.stringify(fact), "utf8")
}

export function factTitle(fact: MemoryFact): string {
  return fact.text.slice(0, 60)
}

/** Deterministic duplicate winner: newer confirmation, then the smaller id. */
export function isOlderThan(left: MemoryFact, right: MemoryFact): boolean {
  if (left.lastConfirmedAt !== right.lastConfirmedAt) {
    return left.lastConfirmedAt < right.lastConfirmedAt
  }
  return left.id > right.id
}
