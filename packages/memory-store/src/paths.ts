/**
 * File names and path rules for the memory directory. The store receives one
 * resolved directory; every path is derived from a fixed name, so no tool or
 * route can choose an arbitrary file. A dot-directory under `chats/` keeps the
 * memory store out of the chat-file scans.
 */
import { join } from "node:path"

export const MEMORY_DIR_NAME = ".memory"
export const FACTS_FILE = "facts.jsonl"
export const INDEX_FILE = "INDEX.md"
export const AUDIT_FILE = "audit.jsonl"
export const LOCK_FILE = ".lock"
const TEMP_PREFIX = ".tmp-"

/** Default location, next to the per-chat directories in the workspace. */
export function defaultMemoryDir(workspaceDir: string): string {
  return join(workspaceDir, "chats", MEMORY_DIR_NAME)
}

export function factsPath(dir: string): string {
  return join(dir, FACTS_FILE)
}

export function indexPath(dir: string): string {
  return join(dir, INDEX_FILE)
}

export function auditPath(dir: string): string {
  return join(dir, AUDIT_FILE)
}

export function lockPath(dir: string): string {
  return join(dir, LOCK_FILE)
}

/** A sibling temp name, so rename stays on the same filesystem. */
export function tempPath(dir: string, name: string, nonce: string): string {
  return join(dir, `${TEMP_PREFIX}${name}.${nonce}`)
}

/** Facts ids are short, opaque, and safe in a URL or a JSONL line. */
export const FACT_ID_PATTERN = /^[a-z][a-z0-9]{7,31}$/

export function isFactId(value: string): boolean {
  return FACT_ID_PATTERN.test(value)
}
