export {
  AUDIT_FILE,
  FACTS_FILE,
  INDEX_FILE,
  LOCK_FILE,
  encodeJsonl,
  ensureMemoryDir,
  parseJsonl,
  readRegularFile,
  withMemoryLock,
  writeAtomic,
} from "./io"
export {
  checkFactText,
  defaultExpiry,
  effectiveStatus,
  isNearDuplicate,
  normalizeText,
  tokensFor,
  trustRank,
} from "./hygiene"
export type { MemoryErrorCode } from "./hygiene"
export {
  INDEX_MAX_CHARS,
  buildIndex,
  estimateTokens,
  rankFacts,
} from "./index-build"
export type { IndexBuild } from "./index-build"
export { MemoryStore } from "./store"
export type { MemoryStoreOptions } from "./store"
export { factChecksum } from "./fact"
export type {
  MemoryAuditEntry,
  MemoryItemResult,
  MemoryUpdateEntry,
  MemoryWriteEntry,
  PruneCandidate,
  PruneOptions,
  PruneReason,
  PruneResult,
} from "./types"
